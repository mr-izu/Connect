/**
 * index.js
 *
 * - Uses local auth state (useMultiFileAuthState)
 * - On connection open: reads creds.json + keys/*.json, assembles into one object,
 *   writes that object into PostgreSQL in a `sessions` table (id TEXT PK, data JSONB).
 * - Sends only Session ID to WhatsApp.
 * - Clears local auth folder after storing to DB.
 * - Supports QR & Pairing Code flows, with proper browser config and pairing waiting.
 *
 * Usage:
 *   QR login:   node index.js
 *   Pair login: node index.js pair 994400540665
 *
 * Dependencies:
 *   npm install @whiskeysockets/baileys @hapi/boom pino qrcode pg
 */

const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestWaWebVersion
} = require('@whiskeysockets/baileys')
const QRCode = require('qrcode')
const { Boom } = require('@hapi/boom')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const pino = require('pino')
const { Client } = require('pg')

// --- Configuration ---

// PostgreSQL connection: replace with your actual URL or set via env var
const PG_CONNECTION = process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_Nlo0HYIwJD3T@ep-royal-lake-aa8hb1m2-pooler.westus3.azure.neon.tech/neondb?sslmode=require'

// Parse CLI args
const args = process.argv.slice(2)
const usePairCode = args[0] === 'pair' && args[1]
const pairPhoneNumber = usePairCode ? args[1] : null

if (usePairCode && !/^\d{10,15}$/.test(pairPhoneNumber)) {
  console.error('❌ Invalid phone number for pairing. Must be 10-15 digits (E.164 without +).')
  process.exit(1)
}

// Global flag to request pairing only once per run
let globalPairingRequested = false

// Logger
const logger = pino({
  level: 'silent',
  transport: { target: 'pino-pretty', options: { colorize: true } }
})

// Generate a readable Session ID
function generateSessionID() {
  return 'IzumieConsole~' + crypto.randomBytes(8).toString('base64url')
}

// Read local session files (creds.json + keys/*) into a JS object
function readLocalSession(authDir) {
  const result = {}
  // creds.json
  const credsPath = path.join(authDir, 'creds.json')
  if (fs.existsSync(credsPath)) {
    try {
      const raw = fs.readFileSync(credsPath, 'utf-8')
      result.creds = JSON.parse(raw)
    } catch (e) {
      console.error('❌ Failed to read or parse creds.json:', e.message)
    }
  } else {
    console.warn('⚠️ creds.json not found at', credsPath)
  }

  // keys folder
  const keysDir = path.join(authDir, 'keys')
  if (fs.existsSync(keysDir) && fs.lstatSync(keysDir).isDirectory()) {
    result.keys = {}
    const files = fs.readdirSync(keysDir)
    for (const file of files) {
      const filePath = path.join(keysDir, file)
      if (fs.lstatSync(filePath).isFile()) {
        try {
          const raw = fs.readFileSync(filePath, 'utf-8')
          // parse JSON if possible, else store raw
          try {
            result.keys[file] = JSON.parse(raw)
          } catch {
            result.keys[file] = raw
          }
        } catch (e) {
          console.error(`❌ Failed to read key file ${file}:`, e.message)
        }
      }
    }
  } else {
    console.warn('⚠️ keys folder not found at', keysDir)
  }

  return result
}

// Save session object into PostgreSQL
async function saveSessionToDB(sessionId, sessionObj) {
  const client = new Client({ connectionString: PG_CONNECTION })
  try {
    console.log('🗄️ Connecting to PostgreSQL to save session...')
    await client.connect()
    // Ensure table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)
    // Insert or update
    await client.query(
      `INSERT INTO sessions (id, data) VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, created_at = NOW()`,
      [sessionId, sessionObj]
    )
    console.log(`✅ Session stored in DB with ID: ${sessionId}`)
    return true
  } catch (err) {
    console.error('❌ Error saving session to DB:', err.message)
    return false
  } finally {
    await client.end()
  }
}

// Main start function
async function startSock() {
  console.log('🚀 Starting WhatsApp socket...')
  const sessionId = generateSessionID()
  const AUTH_DIR = './auth_info_baileys'

  // 1) Fetch latest WA Web version (optional but reduces version mismatch)
  let version
  try {
    const [bv, publishDate] = await fetchLatestWaWebVersion()
    version = bv
    console.log(`📦 Using WA Web version: ${version.join('.')}, published ${publishDate}`)
  } catch (e) {
    console.warn('⚠️ Could not fetch WA Web version, using default:', e.message)
    version = undefined
  }

  // 2) Bootstrap local auth state so Baileys generates keys
  // If pairing and you want fresh, you can delete old folder here:
  // if (usePairCode && fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true })
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

  // 3) Create the socket
  const sock = makeWASocket({
    auth: state,
    logger,
    browser: Browsers.macOS('Google Chrome'),
    version,
    // printQRInTerminal is deprecated; we'll handle QR manually
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    console.log('🔄 connection.update:', JSON.stringify(update, null, 2))
    const { connection, lastDisconnect, qr } = update

    // 1) QR flow
    if (qr && !usePairCode) {
      try {
        const qrTerm = await QRCode.toString(qr, { type: 'terminal', small: true })
        console.log('📸 Scan this QR code with WhatsApp:\n', qrTerm)
      } catch {
        console.log('📸 Received QR (unable to render), raw string:', qr)
      }
    }

    // 2) Pairing flow: request code once when keys ready
    if (usePairCode && !globalPairingRequested && connection === 'connecting') {
      let attempts = 0, maxAttempts = 10
      while (attempts < maxAttempts) {
        const noisePub = sock.authState?.creds?.noiseKey?.public
        if (noisePub) {
          try {
            const code = await sock.requestPairingCode(pairPhoneNumber)
            console.log('\n📲 Pairing Code:', code)
            console.log('⚡ Enter this code in WhatsApp within 2 minutes.\n')
            globalPairingRequested = true
            break
          } catch (err) {
            console.error('❌ Pairing request failed (will retry):', err.message)
          }
        }
        await new Promise(r => setTimeout(r, 500))
        attempts++
      }
      if (!globalPairingRequested) {
        console.error('❌ Timed out waiting for keys to request pairing code.')
      }
    }

    // 3) Disconnection logic
    if (connection === 'close') {
      const reason = lastDisconnect?.error
      if (reason instanceof Boom) {
        const status = reason.output?.statusCode
        console.log(`❌ Disconnected, status code: ${status}`)
        if (usePairCode) {
          // If unauthorized: waiting for user to enter pairing code
          if (status === DisconnectReason.unauthorized) {
            console.log('⏳ Waiting for you to enter the pairing code on WhatsApp. Do NOT reconnect now.')
            return
          }
          if (status === DisconnectReason.badSession || status === DisconnectReason.invalidSession) {
            console.error('❌ Bad/invalid session. Delete local auth folder and restart.')
            process.exit(1)
          }
          // Other: optionally retry after delay
          console.log('🔄 Reconnecting in 5s for pairing...')
          setTimeout(() => startSock().catch(console.error), 5000)
        } else {
          // QR mode: reconnect only if restart required
          if (status === DisconnectReason.restartRequired) {
            console.log('🔄 Restart required, reconnecting in 2s...')
            setTimeout(() => startSock().catch(console.error), 2000)
          } else {
            console.log('⚠️ Not reconnecting (status:', status, ')')
          }
        }
      } else {
        console.log('❌ Disconnected with unknown reason:', reason)
      }
    }

    // 4) On successful open
    if (connection === 'open') {
      console.log('✅ Connected to WhatsApp!')
      const jid = usePairCode
        ? pairPhoneNumber.replace(/\D/g, '') + '@s.whatsapp.net'
        : sock.user.id

      // 4a) Read local session files into object
      const sessionObj = readLocalSession(AUTH_DIR)

      // 4b) Save sessionObj into DB
      const saved = await saveSessionToDB(sessionId, sessionObj)

      // 4c) Send only Session ID back
      try {
        if (saved) {
          await sock.sendMessage(jid, {
            text: `✅ Connected Successfully!\n🆔 Session ID: ${sessionId}`
          })
          console.log('📨 Sent Session ID to', jid)
        } else {
          await sock.sendMessage(jid, {
            text: `⚠️ Connected but failed to store session to database.`
          })
          console.warn('⚠️ Session not saved to DB, notified user.')
        }
      } catch (err) {
        console.error('❌ Failed to send message to WhatsApp:', err.message)
      }

      // 4d) Clear local auth folder if desired
      try {
        if (fs.existsSync(AUTH_DIR)) {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true })
          console.log('🧹 Cleared local auth folder:', AUTH_DIR)
        }
      } catch (e) {
        console.error('❌ Failed to clear local auth folder:', e.message)
      }
    }
  })
}

// Helper: read local session
function readLocalSession(authDir) {
  const res = {}
  // creds.json
  const credsPath = path.join(authDir, 'creds.json')
  if (fs.existsSync(credsPath)) {
    try {
      res.creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'))
    } catch (e) {
      console.error('❌ Error parsing creds.json:', e.message)
      res.creds = null
    }
  }
  // keys folder
  const keysDir = path.join(authDir, 'keys')
  if (fs.existsSync(keysDir) && fs.lstatSync(keysDir).isDirectory()) {
    res.keys = {}
    for (const file of fs.readdirSync(keysDir)) {
      const p = path.join(keysDir, file)
      if (fs.lstatSync(p).isFile()) {
        try {
          const raw = fs.readFileSync(p, 'utf-8')
          try { res.keys[file] = JSON.parse(raw) }
          catch { res.keys[file] = raw }
        } catch (e) {
          console.error(`❌ Error reading key file ${file}:`, e.message)
        }
      }
    }
  }
  return res
}

// Start
startSock().catch(err => {
  console.error('Fatal error in startSock():', err)
})
