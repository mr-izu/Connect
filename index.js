const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers
} = require('@whiskeysockets/baileys')
const QRCode = require('qrcode')
const { Boom } = require('@hapi/boom')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { Client } = require('pg')
const pino = require('pino')

// PostgreSQL setup (Neon)
const pgClient = new Client({
  connectionString: 'postgresql://neondb_owner:npg_Nlo0HYIwJD3T@ep-royal-lake-aa8hb1m2-pooler.westus3.azure.neon.tech/neondb?sslmode=require'
})

pgClient.connect().catch(err => {
  console.error('❌ Failed to connect to PostgreSQL:', err.message)
})

// Parse command-line arguments
const args = process.argv.slice(2)
const usePairCode = args[0] === 'pair' && args[1]
const pairPhoneNumber = usePairCode ? args[1] : null
let globalPairingRequested = false

// Logger
const logger = pino({
  level: 'silent',
  transport: {
    target: 'pino-pretty',
    options: { colorize: true }
  }
})

// Generate session ID
function generateSessionID() {
  return 'IzumieConsole~' + crypto.randomBytes(8).toString('base64url')
}

// Save creds to DB, then clear local
async function handleCreds(sessionId, credsPath) {
  try {
    const rawCreds = fs.readFileSync(credsPath, 'utf-8')
    await pgClient.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL
      );
    `)
    await pgClient.query(
      `INSERT INTO sessions (id, data) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
      [sessionId, JSON.parse(rawCreds)]
    )
    fs.rmSync(path.dirname(credsPath), { recursive: true, force: true }) // delete folder
    return true
  } catch (err) {
    console.error('❌ Failed saving session:', err.message)
    return false
  }
}

async function startSock() {
  const sessionId = generateSessionID()
  const { state, saveCreds } = await useMultiFileAuthState('./auth_temp')

  const sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: !usePairCode,
    browser: Browsers.macOS('Google Chrome')
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr && !usePairCode) {
      console.log(await QRCode.toString(qr, { type: 'terminal', small: true }))
    }

    if (usePairCode && !globalPairingRequested && (connection === 'connecting' || qr)) {
      globalPairingRequested = true
      await new Promise(r => setTimeout(r, 3000))
      try {
        const code = await sock.requestPairingCode(pairPhoneNumber)
        console.log(`\n📲 Pairing code: ${code}`)
      } catch (err) {
        console.error('❌ Pairing failed:', err.message)
      }
    }

    if (connection === 'open') {
      console.log('✅ Connected to WhatsApp!')

      const credsPath = path.join('./auth_temp', 'creds.json')
      const success = await handleCreds(sessionId, credsPath)

      const jid = usePairCode
        ? pairPhoneNumber.replace(/\D/g, '') + '@s.whatsapp.net'
        : sock.user.id

      try {
        await sock.sendMessage(jid, {
          text: success
            ? `✅ Connected Successfully!\n🗝️ Session ID: ${sessionId}`
            : `⚠️ Connected but failed to store session.`
        })
        console.log('📨 Session ID sent.')
      } catch (err) {
        console.error('❌ Failed to send session message:', err.message)
      }
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error
      let shouldReconnect = false

      if (reason instanceof Boom) {
        const status = reason.output?.statusCode
        shouldReconnect = usePairCode
          ? status !== DisconnectReason.badSession && status !== DisconnectReason.invalidSession
          : status === DisconnectReason.restartRequired

        if (!shouldReconnect) {
          console.log('❌ Disconnected:', reason.message)
        }
      }

      if (shouldReconnect) {
        console.log('🔄 Reconnecting...')
        setTimeout(() => startSock().catch(console.error), 2000)
      }
    }
  })
}

// Validate and start
if (usePairCode && !/^\d{10,15}$/.test(pairPhoneNumber)) {
  console.error('❌ Invalid phone number. Must be E.164 format without "+"')
  process.exit(1)
}
startSock().catch(console.error)
