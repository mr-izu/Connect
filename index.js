const { makeWASocket, DisconnectReason, useSingleFileAuthState } = require('@whiskeysockets/baileys')
const QRCode = require('qrcode')
const { Boom } = require('@hapi/boom')
const { Client } = require('pg')
const pino = require('pino')
const crypto = require('crypto')

// Parse command line
const args = process.argv.slice(2)
const usePairCode = args[0] === 'pair' && args[1]
const pairPhoneNumber = usePairCode ? args[1] : null

// PostgreSQL config
const pgClient = new Client({
  connectionString: process.env.DATABASE_URL || 'postgres://user:pass@localhost:5432/yourdb'
})
pgClient.connect()

const pgTable = 'auth_state'

// Generate readable session ID
function generateSessionID() {
  const rand = crypto.randomBytes(8).toString('base64url')
  return `IzumieConsole~${rand}`
}

// PostgreSQL session storage
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

// Custom Baileys auth state using PostgreSQL
async function usePostgresAuthState(sessionId) {
  let creds = await loadData(`${sessionId}:creds`)
  let keys = await loadData(`${sessionId}:keys`)

  if (!creds || !keys) {
    creds = {} // fresh start
    keys = {}
  }

  const saveCreds = async () => {
    await saveData(`${sessionId}:creds`, creds)
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
const logger = pino({ level: 'silent', transport: { target: 'pino-pretty', options: { colorize: true } } })

// Start socket with generated session ID
async function startSock() {
  const sessionId = generateSessionID()
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
      console.log(await QRCode.toString(qr, { type: 'terminal', small: true }))
    }

    if (usePairCode && connection === 'connecting') {
      try {
        await new Promise(r => setTimeout(r, 2000))
        const code = await sock.requestPairingCode(pairPhoneNumber)
        console.log(`Pairing code for ${pairPhoneNumber}: ${code}`)
      } catch (err) {
        console.error('Pairing failed:', err.message)
      }
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error
      if (reason instanceof Boom) {
        const statusCode = reason.output?.statusCode
        const shouldReconnect =
          usePairCode
            ? statusCode !== DisconnectReason.badSession && statusCode !== DisconnectReason.invalidSession
            : statusCode === DisconnectReason.restartRequired

        if (shouldReconnect) {
          console.log('Reconnecting...')
          setTimeout(startSock, 2000)
        } else {
          console.log('Connection closed:', reason?.output?.payload || reason)
        }
      }
    }

    if (connection === 'open') {
      console.log('\n✅ Connected to WhatsApp!')
      try {
        const jid = usePairCode ? pairPhoneNumber.replace(/\D/g, '') + '@s.whatsapp.net' : sock.user.id
        await sock.sendMessage(jid, { text: `✅ Your Session ID: ${sessionId}` })
        console.log(`Sent session ID (${sessionId}) to`, jid)
      } catch (err) {
        console.error('Failed to send session ID:', err.message)
      }
    }
  })
}

// Entry
if (usePairCode) {
  if (!pairPhoneNumber || !/^\d{10,15}$/.test(pairPhoneNumber)) {
    console.error('Invalid phone number format')
    process.exit(1)
  }
  startSock()
} else {
  startSock()
}
