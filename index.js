const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const QRCode = require('qrcode')
const { Boom } = require('@hapi/boom')
const { Client } = require('pg')
const crypto = require('crypto')
const fs = require('fs')
const pino = require('pino')

// Create proper Pino logger
const logger = pino({
  level: 'silent',
  transport: {
    target: 'pino-pretty',
    options: { colorize: true }
  }
})

// PostgreSQL client setup
const pgClient = new Client({
  connectionString: 'postgresql://neondb_owner:npg_Nlo0HYIwJD3T@ep-royal-lake-aa8hb1m2-pooler.westus3.azure.neon.tech/neondb?sslmode=require'
})

// Connect to PostgreSQL
pgClient.connect()
  .then(() => console.log('Connected to PostgreSQL'))
  .catch(err => console.error('PostgreSQL connection error', err))

// Generate session ID with prefix
function generateSessionId() {
  const randomString = crypto.randomBytes(10).toString('hex')
  return `IzumieConsole~${randomString}`
}

// Function to store session in PostgreSQL
async function storeSession(sessionId, sessionData) {
  try {
    await pgClient.query(
      `INSERT INTO sessions (session_id, session_data)
       VALUES ($1, $2)
       ON CONFLICT (session_id)
       DO UPDATE SET session_data = $2`,
      [sessionId, sessionData]
    )
    console.log(`Session stored with ID: ${sessionId}`)
  } catch (err) {
    console.error('Error storing session:', err.message)
  }
}

// Parse command line arguments
const args = process.argv.slice(2)
const usePairCode = args[0] === 'pair' && args[1]
const pairPhoneNumber = usePairCode ? args[1] : null
const sessionId = args[2] || null

globalPairingRequested = false

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys')
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: !usePairCode,
    logger: logger
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
        
        // Store session ONLY AFTER successful connection
        if (!sessionId) {
          const newSessionId = generateSessionId()
          console.log(`Session ID: ${newSessionId}`)
          
          // Read the entire auth directory
          const authDir = './auth_info_baileys'
          const files = fs.readdirSync(authDir)
          const sessionData = {}
          
          for (const file of files) {
            sessionData[file] = fs.readFileSync(`${authDir}/${file}`, 'utf8')
          }
          
          // Store in PostgreSQL
          await storeSession(newSessionId, JSON.stringify(sessionData))
        }
      } catch (err) {
        console.error('Failed to send confirmation:', err.message)
      }
    }
  })
}

// Validate arguments and start
if (usePairCode) {
  if (!pairPhoneNumber || !/^\d{10,15}$/.test(pairPhoneNumber)) {
    console.error('Invalid phone number. Must be 10-15 digits (E.164 format without +)')
    process.exit(1)
  }
}
startSock()

// Close DB connection on exit
process.on('exit', () => pgClient.end())
process.on('SIGINT', () => process.exit())
