const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const QRCode = require('qrcode')
const { Boom } = require('@hapi/boom')
const fs = require('fs')
const { Client } = require('pg')
const crypto = require('crypto')
const pino = require('pino')

// PostgreSQL connection string
const DB_URL = 'postgresql://neondb_owner:npg_Nlo0HYIwJD3T@ep-royal-lake-aa8hb1m2-pooler.westus3.azure.neon.tech/neondb?sslmode=require'

// Parse command line arguments
const args = process.argv.slice(2)
const usePairCode = args[0] === 'pair' && args[1]
const pairPhoneNumber = usePairCode ? args[1] : null

// Global session tracking
let sessionId = null
let globalPairingRequested = false
let sessionCreated = false

// Create proper Pino logger
const logger = pino({
  level: 'silent',
  transport: {
    target: 'pino-pretty',
    options: { colorize: true }
  }
})

// Generate session ID with pattern: IzumieConsole~<random_string>
function generateSessionId() {
  const randomString = crypto.randomBytes(8).toString('hex')
  return `IzumieConsole~${randomString}`
}

// PostgreSQL session manager
async function usePostgresAuthState() {
  const client = new Client({ connectionString: DB_URL })
  await client.connect()
  
  // Create sessions table if not exists
  await client.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_sessions (
      session_id TEXT PRIMARY KEY,
      phone_number TEXT,
      session_data JSONB NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      connected_at TIMESTAMP
    )
  `)
  
  return {
    client,
    state: {
      creds: { },
      keys: { }
    },
    saveCreds: async () => {
      if (sessionId && sessionCreated) {
        await client.query(`
          INSERT INTO whatsapp_sessions (session_id, phone_number, session_data)
          VALUES ($1, $2, $3)
          ON CONFLICT (session_id) 
          DO UPDATE SET 
            session_data = EXCLUDED.session_data,
            connected_at = NOW()
        `, [
          sessionId,
          pairPhoneNumber || null,
          JSON.stringify({ creds: this.state.creds, keys: this.state.keys })
        ])
      }
    },
    removeCreds: async () => {
      if (sessionId) {
        await client.query('DELETE FROM whatsapp_sessions WHERE session_id = $1', [sessionId])
      }
    }
  }
}

// Clean up old sessions if starting fresh
if (usePairCode && fs.existsSync('./auth_info_baileys')) {
  fs.rmSync('./auth_info_baileys', { recursive: true, force: true })
}

async function startSock() {
  // Generate session ID
  sessionId = generateSessionId()
  
  // Initialize PostgreSQL auth
  const { client, state, saveCreds, removeCreds } = await usePostgresAuthState()
  sessionCreated = true
  
  const sock = makeWASocket({
    auth: state,
    logger: logger, // Use proper Pino logger
    shouldIgnoreJid: () => true, // Reduce noise
    syncFullHistory: false // Reduce load
  })

  sock.ev.on('creds.update', () => {
    state.creds = sock.authState.creds
    saveCreds()
  })

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    // QR code flow - manual handling
    if (qr && !usePairCode) {
      console.log('Scan this QR code with your WhatsApp app:')
      QRCode.toString(qr, { type: 'terminal', small: true }, (err, url) => {
        if (err) throw err
        console.log(url)
      })
    }

    // Pair code flow
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
        console.log('Enter this code on your WhatsApp within 2 minutes')
      } catch (err) {
        console.error('Pairing failed:', err.message)
      }
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error
      let shouldReconnect = false

      if (reason instanceof Boom) {
        const statusCode = reason.output?.statusCode
        
        // Special handling for pairing mode
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
        await removeCreds()
        await client.end()
      }
    }

    if (connection === 'open') {
      console.log('\nSuccessfully connected to WhatsApp!')
      
      // Save session to database
      state.creds = sock.authState.creds
      state.keys = sock.authState.keys
      await saveCreds()
      
      try {
        let jid
        if (usePairCode) {
          // For pair mode: send to provided number
          jid = pairPhoneNumber.replace(/\D/g, '') + '@s.whatsapp.net'
        } else {
          // For QR mode: send to the bot's own number
          jid = sock.user.id
        }
        
        // Send session ID message
        const message = `This is your Session ID: ${sessionId}\nKeep it safe, from Console`
        await sock.sendMessage(jid, { text: message })
        console.log(`Sent session ID ${sessionId} to`, jid.split('@')[0])
      } catch (err) {
        console.error('Failed to send session ID:', err.message)
      } finally {
        await client.end()
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
