/**
 * index.js
 *
 * Full working Baileys bot with:
 * - QR / Pairing Code login flows
 * - Dynamic WA Web version fetch
 * - Browser config for pairing
 * - Debug logs for connection states
 * - Bootstrapping auth state (useMultiFileAuthState) to generate keys
 * - Saving session (creds + keys) to PostgreSQL AFTER successful connection
 * - Auto-generated Session ID sent via WhatsApp
 *
 * Usage:
 *   For QR login: `node index.js`
 *   For Pair login: `node index.js pair 994400540665`
 *
 * Before first run, ensure you have installed:
 *   npm install @whiskeysockets/baileys @hapi/boom pino pg qrcode
 *
 * And that Termux network allows outbound TLS/WSS.
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
const { Client } = require('pg')
const crypto = require('crypto')
const pino = require('pino')
const fs = require('fs')
const path = require('path')

// ------ Configuration ------

// Parse CLI args
const args = process.argv.slice(2)
const usePairCode = args[0] === 'pair' && args[1]
const pairPhoneNumber = usePairCode ? args[1] : null

// PostgreSQL Neon DB: your provided connection string
const PG_CONNECTION = 'postgresql://neondb_owner:npg_Nlo0HYIwJD3T@ep-royal-lake-aa8hb1m2-pooler.westus3.azure.neon.tech/neondb?sslmode=require'

// Path to temporary auth state folder
const AUTH_TEMP_DIR = './auth_temp'

// Pino logger (silent by default; set to 'info' or 'debug' to see more)
const logger = pino({
  level: 'silent',
  transport: {
    target: 'pino-pretty',
    options: { colorize: true }
  }
})

// Generate a readable Session ID
function generateSessionID() {
  return 'IzumieConsole~' + crypto.randomBytes(8).toString('base64url')
}

// Save session (creds + keys) to PostgreSQL
async function saveSessionToDB(sessionId, creds, keys) {
  const client = new Client({ connectionString: PG_CONNECTION })
  try {
    console.log('🗄️ Connecting to PostgreSQL to save session...')
    await client.connect()

    // Ensure table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS auth_state (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL
      );
    `)

    // Save creds
    await client.query(
      `INSERT INTO auth_state (id, data) VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
      [`${sessionId}:creds`, creds]
    )
    // Save keys
    await client.query(
      `INSERT INTO auth_state (id, data) VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
      [`${sessionId}:keys`, keys]
    )

    console.log(`🗃️ Session saved to PostgreSQL: ${sessionId}`)
  } catch (err) {
    console.error('❌ PostgreSQL error while saving session:', err.message)
  } finally {
    await client.end()
  }
}

// Wait for pairing code readiness with retries
async function waitForPairingCode(sock, number) {
  const maxRetries = 10
  let attempt = 0
  while (attempt < maxRetries) {
    try {
      // Baileys attaches creds under sock.authState.creds
      // We check if noiseKey.public exists as indicator keys ready
      const noisePub = sock.authState?.creds?.noiseKey?.public
      if (noisePub) {
        const code = await sock.requestPairingCode(number)
        console.log('\n📲 Pairing Code:', code)
        console.log('⚡ Enter this in WhatsApp within 2 minutes.\n')
        return
      }
    } catch (err) {
      console.log('⌛ Waiting for internal keys to be ready for pairing...')
    }
    await new Promise(res => setTimeout(res, 500))
    attempt++
  }
  console.error('❌ Timed out waiting for key generation to request pairing code.')
}

// Main function to start socket
async function startSock() {
  console.log('🚀 Starting WhatsApp socket...')
  const sessionId = generateSessionID()

  // Clean up old auth_temp if exists? (optional)
  try {
    if (fs.existsSync(AUTH_TEMP_DIR)) {
      // You may comment out next line if you want to persist between runs.
      // fs.rmSync(AUTH_TEMP_DIR, { recursive: true, force: true })
    }
  } catch (e) {
    // ignore
  }

  // 1) Fetch latest WA Web version to reduce version-mismatch errors
  let version = undefined
  try {
    const [browserVersion, publishDate] = await fetchLatestWaWebVersion()
    version = browserVersion
    console.log(`📦 Using WA Web version: ${version.join('.')}, published ${publishDate}`)
  } catch (err) {
    console.warn('⚠️ Could not fetch latest WA Web version, proceeding with default:', err.message)
    version = undefined
  }

  // 2) Bootstrap with useMultiFileAuthState so Baileys generates keys
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_TEMP_DIR)

  // 3) Create socket
  const sock = makeWASocket({
    auth: state,
    logger,
    // printQRInTerminal is deprecated; we handle QR manually below
    // printQRInTerminal: !usePairCode,
    browser: Browsers.macOS('Google Chrome'),
    version,          // may be undefined if fetch failed, else array [x,y,z]
    // markOnlineOnConnect: false, // optional
    // You can add other config: syncFullHistory, getMessage, etc.
  })

  // On any creds.update, save to file (so next runs can reuse). We'll still save to DB after open.
  sock.ev.on('creds.update', saveCreds)

  // Listen for connection updates
  sock.ev.on('connection.update', async (update) => {
    console.log('🔄 connection.update:', JSON.stringify(update, null, 2))
    const { connection, lastDisconnect, qr } = update

    // 1) QR code flow (if QR login)
    if (qr && !usePairCode) {
      try {
        const qrStr = await QRCode.toString(qr, { type: 'terminal', small: true })
        console.log('📸 Scan this QR code with WhatsApp:\n', qrStr)
      } catch (e) {
        console.log('📸 QR received (unable to render in terminal):', qr)
      }
    }

    // 2) Pairing code flow
    if (usePairCode && connection === 'connecting') {
      // Only request once
      await waitForPairingCode(sock, pairPhoneNumber)
    }

    // 3) Disconnection handling
    if (connection === 'close') {
      const reason = lastDisconnect?.error
      if (reason instanceof Boom) {
        const code = reason.output?.statusCode
        console.log(`❌ Disconnected, status code: ${code}`)
        const shouldReconnect = usePairCode
          ? (code !== DisconnectReason.badSession && code !== DisconnectReason.invalidSession)
          : (code === DisconnectReason.restartRequired)
        if (shouldReconnect) {
          console.log('🔄 Reconnecting in 2s...')
          setTimeout(() => startSock().catch(console.error), 2000)
        } else {
          console.log('⚠️ Will not reconnect. Reason:', reason.message)
        }
      } else {
        console.log('❌ Disconnected with unknown reason:', reason)
      }
    }

    // 4) On successful open
    if (connection === 'open') {
      console.log('✅ Connected to WhatsApp!')
      try {
        const jid = usePairCode
          ? pairPhoneNumber.replace(/\D/g, '') + '@s.whatsapp.net'
          : sock.user.id

        // Send Session ID back
        await sock.sendMessage(jid, { text: `✅ Your Session ID: ${sessionId}` })
        console.log(`📨 Session ID sent to ${jid}`)

        // Save session creds + keys to PostgreSQL
        await saveSessionToDB(sessionId, state.creds, state.keys)
      } catch (err) {
        console.error('❌ Failed sending session ID or saving session:', err.message)
      }
    }
  })

  // Listen to other useful events/logs if desired:
  // sock.ev.on('creds.update', ... ) // already set
  // sock.ev.on('messages.upsert', ... ) // your message handling logic here
}

// Entry point
if (usePairCode) {
  if (!/^\d{10,15}$/.test(pairPhoneNumber)) {
    console.error('❌ Invalid phone number format. Use E.164 without +')
    process.exit(1)
  }
  startSock().catch(err => {
    console.error('Fatal error in startSock:', err)
  })
} else {
  startSock().catch(err => {
    console.error('Fatal error in startSock:', err)
  })
}
