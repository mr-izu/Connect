const { makeWASocket, DisconnectReason } = require('@whiskeysockets/baileys')
const QRCode = require('qrcode')
const { Boom } = require('@hapi/boom')
const { Client } = require('pg')
const crypto = require('crypto')
const pino = require('pino')

// Parse CLI args
const args = process.argv.slice(2)
const usePairCode = args[0] === 'pair' && args[1]
const pairPhoneNumber = usePairCode ? args[1] : null

// PostgreSQL connection (Neon DB)
const pgClient = new Client({
  connectionString: 'postgresql://neondb_owner:npg_Nlo0HYIwJD3T@ep-royal-lake-aa8hb1m2-pooler.westus3.azure.neon.tech/neondb?sslmode=require'
})

const logger = pino({ level: 'silent', transport: { target: 'pino-pretty', options: { colorize: true } } })

function generateSessionID() {
  return 'IzumieConsole~' + crypto.randomBytes(8).toString('base64url')
}

async function saveSessionToDB(sessionId, creds, keys) {
  try {
    console.log('🗄️ Connecting to PostgreSQL...')
    await pgClient.connect()

    await pgClient.query(`
      CREATE TABLE IF NOT EXISTS auth_state (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL
      );
    `)

    await pgClient.query(`
      INSERT INTO auth_state (id, data) VALUES ($1, $2)
      ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data
    `, [`${sessionId}:creds`, creds])

    await pgClient.query(`
      INSERT INTO auth_state (id, data) VALUES ($1, $2)
      ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data
    `, [`${sessionId}:keys`, keys])
  } catch (err) {
    console.error('❌ Failed to save session:', err.message)
  } finally {
    await pgClient.end()
  }
}

async function startSock() {
  console.log('🚀 Starting WhatsApp socket...')
  const sessionId = generateSessionID()
  let credentials = {}
  let keys = {}

  const sock = makeWASocket({
    auth: {
      creds: credentials,
      keys: {
        get: async (type, ids) =>
          Object.fromEntries(ids.map(id => [id, keys?.[`${type}:${id}`]]).filter(([, v]) => v)),
        set: async data => {
          for (const category in data) {
            for (const id in data[category]) {
              keys[`${category}:${id}`] = data[category][id]
            }
          }
        }
      }
    },
    printQRInTerminal: !usePairCode,
    logger
  })

  let pairingRequested = false

  sock.ev.on('creds.update', creds => {
    credentials = creds
  })

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr && !usePairCode) {
      console.log(await QRCode.toString(qr, { type: 'terminal', small: true }))
    }

    if (
      usePairCode &&
      !pairingRequested &&
      connection === 'connecting' &&
      sock.authState?.creds?.noiseKey?.public
    ) {
      pairingRequested = true
      try {
        const code = await sock.requestPairingCode(pairPhoneNumber)
        console.log('\n📲 Pairing Code:', code)
        console.log('Enter this code in your WhatsApp (valid for 2 minutes).\n')
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

        await saveSessionToDB(sessionId, credentials, keys)
        console.log('🗃️ Session saved to PostgreSQL:', sessionId)
      } catch (err) {
        console.error('❌ Failed to send message or save session:', err.message)
      }
    }
  })
}

// Run
if (usePairCode) {
  if (!/^\d{10,15}$/.test(pairPhoneNumber)) {
    console.error('❌ Invalid phone number format')
    process.exit(1)
  }
  startSock().catch(console.error)
} else {
  startSock().catch(console.error)
}
