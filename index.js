const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers
} = require('@whiskeysockets/baileys')
const QRCode = require('qrcode')
const { Boom } = require('@hapi/boom')
const { Client } = require('pg')
const crypto = require('crypto')
const pino = require('pino')

// Parse CLI args
const args = process.argv.slice(2)
const usePairCode = args[0] === 'pair' && args[1]
const pairPhoneNumber = usePairCode ? args[1] : null

// PostgreSQL Neon DB
const pgClient = new Client({
  connectionString: 'postgresql://neondb_owner:npg_Nlo0HYIwJD3T@ep-royal-lake-aa8hb1m2-pooler.westus3.azure.neon.tech/neondb?sslmode=require'
})

// Pino logger
const logger = pino({
  level: 'silent',
  transport: { target: 'pino-pretty', options: { colorize: true } }
})

// Session ID generator
function generateSessionID() {
  return 'IzumieConsole~' + crypto.randomBytes(8).toString('base64url')
}

// Save session to PostgreSQL
async function saveSessionToDB(sessionId, creds, keys) {
  try {
    await pgClient.connect()
    await pgClient.query(`
      CREATE TABLE IF NOT EXISTS auth_state (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL
      );
    `)

    await pgClient.query(
      `INSERT INTO auth_state (id, data) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
      [`${sessionId}:creds`, creds]
    )

    await pgClient.query(
      `INSERT INTO auth_state (id, data) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
      [`${sessionId}:keys`, keys]
    )
  } catch (err) {
    console.error('❌ PostgreSQL error:', err.message)
  } finally {
    await pgClient.end()
  }
}

// Start WhatsApp socket
async function startSock() {
  console.log('🚀 Starting WhatsApp socket...')
  const sessionId = generateSessionID()

  // Temporarily use file-based auth state to bootstrap creds
  const { state, saveCreds } = await useMultiFileAuthState('./auth_temp')

  const sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: !usePairCode,
    browser: Browsers.macOS('Google Chrome') // ✅ required for pair code
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr && !usePairCode) {
      console.log(await QRCode.toString(qr, { type: 'terminal', small: true }))
    }

    if (usePairCode && connection === 'connecting') {
      try {
        const code = await sock.requestPairingCode(pairPhoneNumber)
        console.log('\n📲 Pairing Code:', code)
        console.log('⚡ Enter this in WhatsApp within 2 minutes.\n')
      } catch (err) {
        console.error('❌ Pairing failed:', err.message)
      }
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error
      if (reason instanceof Boom) {
        const code = reason.output?.statusCode
        const shouldReconnect = usePairCode
          ? code !== DisconnectReason.badSession && code !== DisconnectReason.invalidSession
          : code === DisconnectReason.restartRequired

        if (shouldReconnect) {
          console.log('🔄 Reconnecting...')
          setTimeout(() => startSock().catch(console.error), 2000)
        } else {
          console.log('❌ Disconnected:', reason.message)
        }
      }
    }

    if (connection === 'open') {
      console.log('✅ Connected to WhatsApp!')

      try {
        const jid = usePairCode ? pairPhoneNumber.replace(/\D/g, '') + '@s.whatsapp.net' : sock.user.id
        await sock.sendMessage(jid, { text: `✅ Your Session ID: ${sessionId}` })
        console.log(`📨 Session ID sent to ${jid}`)

        await saveSessionToDB(sessionId, state.creds, state.keys)
        console.log('🗄️ Session saved to PostgreSQL:', sessionId)
      } catch (err) {
        console.error('❌ Failed to send message or save session:', err.message)
      }
    }
  })
}

// Run logic
if (usePairCode) {
  if (!/^\d{10,15}$/.test(pairPhoneNumber)) {
    console.error('❌ Invalid phone number format. Use E.164 without +')
    process.exit(1)
  }
  startSock().catch(console.error)
} else {
  startSock().catch(console.error)
}
