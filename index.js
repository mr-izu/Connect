const { makeWASocket, DisconnectReason, initAuthCreds } = require('@whiskeysockets/baileys')
const QRCode = require('qrcode')
const { Boom } = require('@hapi/boom')
const { Client } = require('pg')
const crypto = require('crypto')
const pino = require('pino')

// PostgreSQL connection string
const DB_URL = 'postgresql://neondb_owner:npg_Nlo0HYIwJD3T@ep-royal-lake-aa8hb1m2-pooler.westus3.azure.neon.tech/neondb?sslmode=require'

// Parse command line arguments
const args = process.argv.slice(2)
const usePairCode = args[0] === 'pair' && args[1]
const pairPhoneNumber = usePairCode ? args[1] : null

// Global flag to track pairing
let globalPairingRequested = false

// Create proper Pino logger
const logger = pino({ level: 'silent' })

// Generate session ID with pattern: IzumieConsole~<random_string>
function generateSessionId() {
  const randomString = crypto.randomBytes(8).toString('hex')
  return `IzumieConsole~${randomString}`
}

// Save session to database ONLY after successful connection
async function saveSessionToDatabase(sessionId, phoneNumber, sessionData) {
  const client = new Client({ connectionString: DB_URL })
  try {
    await client.connect()
    await client.query(`
      INSERT INTO whatsapp_sessions (session_id, phone_number, session_data, connected_at)
      VALUES ($1, $2, $3, NOW())
    `, [sessionId, phoneNumber, JSON.stringify(sessionData)])
    console.log(`Session saved to database: ${sessionId}`)
  } catch (err) {
    console.error('Failed to save session:', err.message)
  } finally {
    await client.end()
  }
}

async function startSock() {
  // Create initial empty auth state
  const authState = {
    creds: initAuthCreds(),
    keys: {}
  }
  
  const sock = makeWASocket({
    auth: authState,
    logger: logger,
    connectTimeoutMs: 30000, // Increased timeout for pairing
    browser: ["Ubuntu", "Chrome", "22.04.4"],
    keepAliveIntervalMs: 10000, // Keep connection alive
    maxIdleTimeMs: 30000, // Allow more idle time
    printQRInTerminal: !usePairCode // Enable QR display if needed
  })

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr, isNewLogin } = update
    console.log('Connection update:', connection)

    // QR code flow
    if (qr && !usePairCode) {
      console.log('Scan this QR code with your WhatsApp app:')
      console.log(await QRCode.toString(qr, { type: 'terminal', small: true }))
    }

    // Pair code flow - wait until connection is 'connecting' and stable
    if (usePairCode && !globalPairingRequested && (connection === 'connecting' || connection === 'open')) {
      globalPairingRequested = true
      try {
        // Wait a moment to ensure connection is ready
        await new Promise(resolve => setTimeout(resolve, 2000))
        
        const code = await sock.requestPairingCode(pairPhoneNumber)
        console.log('\nPairing code for', pairPhoneNumber, ':', code)
        console.log('Enter this code on your WhatsApp within 2 minutes')
      } catch (err) {
        console.error('Pairing failed:', err.message)
        // Reset flag to allow retry
        globalPairingRequested = false
      }
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error
      console.log('Connection closed:', reason?.output?.payload || reason || 'unknown')
      
      // Reconnect if it's a restartable error
      if (reason instanceof Boom) {
        const statusCode = reason.output?.statusCode
        if (statusCode === DisconnectReason.restartRequired) {
          console.log('Reconnecting...')
          setTimeout(startSock, 2000)
        }
      }
    }

    if (connection === 'open') {
      console.log('\nSuccessfully connected to WhatsApp!')
      
      // Generate session ID AFTER successful connection
      const sessionId = generateSessionId()
      
      // Save session to database
      const sessionData = {
        creds: authState.creds,
        keys: authState.keys
      }
      
      const phone = usePairCode ? pairPhoneNumber : sock.user.id.split(':')[0]
      await saveSessionToDatabase(sessionId, phone, sessionData)
      
      // Send session ID to user
      try {
        const jid = usePairCode ? 
          `${pairPhoneNumber}@s.whatsapp.net` : 
          sock.user.id
        
        const message = `This is your Session ID: ${sessionId}\nKeep it safe, from Console`
        await sock.sendMessage(jid, { text: message })
        console.log(`Sent session ID to ${jid.split('@')[0]}`)
      } catch (err) {
        console.error('Failed to send session ID:', err.message)
      }
    }
  })
}

// Start logic
if (usePairCode) {
  if (!pairPhoneNumber || !/^\d{10,15}$/.test(pairPhoneNumber)) {
    console.error('Invalid phone number. Must be 10-15 digits. Example: 1234567890')
    process.exit(1)
  }
  startSock()
} else {
  startSock()
}
