const { makeWASocket, DisconnectReason } = require('@whiskeysockets/baileys')
const QRCode = require('qrcode')
const { Boom } = require('@hapi/boom')
const { Client } = require('pg')
const pino = require('pino')

// Parse command line arguments
const args = process.argv.slice(2)
const usePairCode = args[0] === 'pair' && args[1]
const pairPhoneNumber = usePairCode ? args[1] : null
const sessionId = args[2] || 'IzumieConsole~DefaultSession'

// Global flag to track pairing across reconnects
let globalPairingRequested = false

// Setup PostgreSQL client
const pgClient = new Client({
  connectionString: process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_Nlo0HYIwJD3T@ep-royal-lake-aa8hb1m2-pooler.westus3.azure.neon.tech/neondb?sslmode=require'
})
pgClient.connect()

const pgTable = 'auth_state'

// PostgreSQL session handler
async function loadData(id) {
  const res = await pgClient.query(`SELECT data FROM ${pgTable} WHERE id = $1`, [id])
  return res.rows[0]?.data || null
}

async function saveData(id, data) {
  await pgClient.query(`
    INSERT INTO ${pgTable} (id, data)
    VALUES ($1, $2)
    ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data
  `, [id, data])
}

async function usePostgresAuthState(id) {
  let creds = await loadData(`${id}:creds`) || {}
  let keys = await loadData(`${id}:keys`) || {}

  const saveCreds = async () => {
    await saveData(`${id}:creds`, creds)
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) =>
          Object.fromEntries(
            ids.map(id => [id, keys?.[`${type}:${id}`]]).filter(([, v]) => v)
          ),
        set: async data => {
          for (const category in data) {
            for (const id in data[category]) {
              keys[`${category}:${id}`] = data[category][id]
            }
          }
          await saveData(`${sessionId}:keys`, keys)
        }
      }
    },
    saveCreds
  }
}

// Logger
const logger = pino({
  level: 'silent',
  transport: {
    target: 'pino-pretty',
    options: { colorize: true }
  }
})

// Start Socket
async function startSock() {
  const { state, saveCreds } = await usePostgresAuthState(sessionId)

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: !usePairCode,
    logger: logger
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr && !usePairCode) {
      console.log('Scan this QR code with your WhatsApp app:')
      console.log(await QRCode.toString(qr, { type: 'terminal', small: true }))
    }

    if (
      usePairCode &&
      !globalPairingRequested &&
      (connection === 'connecting' || qr)
    ) {
      globalPairingRequested = true
      try {
        await new Promise(r => setTimeout(r, 3000))
        const code = await sock.requestPairingCode(pairPhoneNumber)
        console.log('\nPairing code for', pairPhoneNumber, ':', code)
        console.log('Enter this code on your WhatsApp within 2 minutes (phone number must not be linked elsewhere).\n')
      } catch (err) {
        console.error('Pairing failed:', err.message)
      }
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error
      let shouldReconnect = false

      if (reason instanceof Boom) {
        const statusCode = reason.output?.statusCode

        if (usePairCode) {
          shouldReconnect = statusCode !== DisconnectReason.badSession && 
                            statusCode !== DisconnectReason.invalidSession

          if (statusCode === DisconnectReason.unauthorized) {
            console.log('Waiting for pairing code confirmation...')
          }
        } else {
          shouldReconnect = statusCode === DisconnectReason.restartRequired
        }
      }

      if (shouldReconnect) {
        console.log('Reconnecting...')
        setTimeout(startSock, 2000)
      } else {
        console.log('Connection closed:', reason?.output?.payload || reason || 'unknown')
      }
    }

    if (connection === 'open') {
      console.log('\nSuccessfully connected to WhatsApp!')
      try {
        let jid = usePairCode
          ? pairPhoneNumber.replace(/\D/g, '') + '@s.whatsapp.net'
          : sock.user.id

        await sock.sendMessage(jid, { text: `Your Session ID: ${sessionId}` })
        console.log('Sent session ID message to', jid.split('@')[0])
      } catch (err) {
        console.error('Failed to send connected message:', err.message)
      }
    }
  })
}

// Entry Point
if (usePairCode) {
  if (!pairPhoneNumber || !/^\d{10,15}$/.test(pairPhoneNumber)) {
    console.error('Invalid phone number. Must be 10-15 digits (E.164 format without +). Example: 1234567890')
    process.exit(1)
  }
  startSock()
} else {
  startSock()
}
