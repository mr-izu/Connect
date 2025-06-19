const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const QRCode = require('qrcode')
const { Boom } = require('@hapi/boom')
const { Client } = require('pg')
const crypto = require('crypto')

// Generate session password with prefix
function generateSessionPassword() {
  const randomString = crypto.randomBytes(10).toString('hex')
  return `IzumieConsole~${randomString}`
}

// PostgreSQL client setup
const pgClient = new Client({
  connectionString: 'postgresql://neondb_owner:npg_Nlo0HYIwJD3T@ep-royal-lake-aa8hb1m2-pooler.westus3.azure.neon.tech/neondb?sslmode=require'
})

// Connect to PostgreSQL
pgClient.connect()
  .then(() => console.log('Connected to PostgreSQL'))
  .catch(err => console.error('PostgreSQL connection error', err))

// Custom auth state manager for PostgreSQL
async function usePostgresAuthState(sessionPassword) {
  let creds = null
  let keys = {}

  // Load from PostgreSQL
  const res = await pgClient.query(
    'SELECT state FROM sessions WHERE session_password = $1',
    [sessionPassword]
  )
  
  if (res.rows.length > 0) {
    ({ creds, keys } = res.rows[0].state)
  }

  // Save to PostgreSQL
  const saveCreds = async (newCreds) => {
    creds = newCreds
    await pgClient.query(
      `INSERT INTO sessions (session_password, state)
       VALUES ($1, $2)
       ON CONFLICT (session_password)
       DO UPDATE SET state = $2`,
      [sessionPassword, { creds, keys }]
    )
  }

  return {
    state: {
      creds,
      keys: {
        get: (id, pk) => keys[id] || null,
        set: async (keyData) => {
          for (const { id, value } of keyData) {
            keys[id] = value
          }
          await saveCreds(creds)
        }
      }
    },
    saveCreds
  }
}

// Parse command line arguments
const args = process.argv.slice(2)
const usePairCode = args[0] === 'pair' && args[1]
const pairPhoneNumber = usePairCode ? args[1] : null
const sessionPassword = args[2] || generateSessionPassword()

// Log session password
console.log(`Session Password: ${sessionPassword}`)
globalPairingRequested = false

async function startSock() {
  const { state, saveCreds } = await usePostgresAuthState(sessionPassword)
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: !usePairCode,
    logger: { level: 'silent' } // Disable verbose logging
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    // QR code flow
    if (qr && !usePairCode) {
      console.log('Scan this QR code with your WhatsApp app:')
      console.log(await QRCode.toString(qr, { type: 'terminal', small: true }))
    }

    // Pair code flow
    if (usePairCode && !globalPairingRequested && (connection === 'connecting' || qr)) {
      globalPairingRequested = true
      try {
        await new Promise(r => setTimeout(r, 3000))
        const code = await sock.requestPairingCode(pairPhoneNumber)
        console.log('\nPairing code for', pairPhoneNumber, ':', code)
        console.log('Enter this code on your WhatsApp within 2 minutes\n')
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
            console.log('Waiting for pairing confirmation...')
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
        const jid = usePairCode 
          ? pairPhoneNumber.replace(/\D/g, '') + '@s.whatsapp.net'
          : sock.user.id
          
        await sock.sendMessage(jid, { text: 'Connected Success' })
        console.log('Sent confirmation to', jid.split('@')[0])
      } catch (err) {
        console.error('Failed to send confirmation:', err.message)
      }
    }
  })
}

// Validate arguments and start
if (usePairCode && (!pairPhoneNumber || !/^\d{10,15}$/.test(pairPhoneNumber))) {
  console.error('Invalid phone number. Must be 10-15 digits (E.164 format without +)')
  process.exit(1)
}
startSock()

// Close DB connection on exit
process.on('exit', () => pgClient.end())
process.on('SIGINT', () => process.exit())
