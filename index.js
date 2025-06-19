const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const QRCode = require('qrcode')
const { Boom } = require('@hapi/boom')
const pino = require('pino')
const { randomBytes } = require('crypto')
const { Pool } = require('pg')

// PostgreSQL configuration
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_Nlo0HYIwJD3T@ep-royal-lake-aa8hb1m2-pooler.westus3.azure.neon.tech/neondb?sslmode=require',
  ssl: process.env.PG_SSL ? { rejectUnauthorized: false } : false
});

// Create sessions table if not exists
pool.query(`
  CREATE TABLE IF NOT EXISTS whatsapp_sessions (
    session_id TEXT PRIMARY KEY,
    creds JSONB NOT NULL,
    keys JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`).catch(err => console.error('Error creating table:', err))

// Database Auth State Implementation
async function useDatabaseAuthState(sessionId) {
  const saveCreds = async () => {
    try {
      const state = {
        creds: state.creds,
        keys: {
          get: state.keys.get,
          set: state.keys.set
        }
      }
      
      await pool.query(
        `INSERT INTO whatsapp_sessions (session_id, creds, keys)
         VALUES ($1, $2, $3)
         ON CONFLICT (session_id) 
         DO UPDATE SET creds = $2, keys = $3, updated_at = CURRENT_TIMESTAMP`,
        [sessionId, state.creds, state.keys]
      )
    } catch (err) {
      console.error('Failed to save credentials:', err)
    }
  }

  try {
    const res = await pool.query(
      'SELECT creds, keys FROM whatsapp_sessions WHERE session_id = $1',
      [sessionId]
    )
    
    if (res.rows.length > 0) {
      const row = res.rows[0]
      return { 
        state: {
          creds: row.creds,
          keys: {
            get: (type, ids) => row.keys[type] || {},
            set: (data) => {}
          }
        },
        saveCreds
      }
    } else {
      // Create new empty state if not found
      const newState = {
        creds: {},
        keys: {
          get: async (type, ids) => ({}),
          set: async (data) => {}
        }
      }
      return {
        state: newState,
        saveCreds
      }
    }
  } catch (err) {
    console.error('Failed to load session:', err)
    throw err
  }
}

// Generate session ID (IzumieConsole~Hqon29Jwo919bwks format)
function generateSessionId() {
  const prefix = 'IzumieConsole~'
  const randomPart = randomBytes(12).toString('hex')
  return prefix + randomPart
}

// Parse command line arguments
const args = process.argv.slice(2)
const usePairCode = args[0] === 'pair' && args[1]
const pairPhoneNumber = usePairCode ? args[1] : null

// Global flag to track pairing across reconnects
let globalPairingRequested = false
let sessionId = generateSessionId()

// Create logger
const logger = pino({
  level: 'silent',
  transport: {
    target: 'pino-pretty',
    options: { colorize: true }
  }
})

async function startSock() {
  const { state, saveCreds } = await useDatabaseAuthState(sessionId)
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
      console.log('Your Session ID:', sessionId)
      
      try {
        let jid
        if (usePairCode) {
          jid = pairPhoneNumber.replace(/\D/g, '') + '@s.whatsapp.net'
        } else {
          jid = sock.user.id
        }
        
        await sock.sendMessage(
          jid, 
          { 
            text: `✅ Connected Successfully!\n\n🔑 Your Session ID: \n${sessionId}\n\nUse this ID to manage your session.` 
          }
        )
        console.log('Sent session details to', jid.split('@')[0])
      } catch (err) {
        console.error('Failed to send connected message:', err.message)
      }
    }
  })
}

// Start logic
if (usePairCode) {
  if (!pairPhoneNumber || !/^\d{10,15}$/.test(pairPhoneNumber)) {
    console.error('Invalid phone number. Must be 10-15 digits (E.164 format without +). Example: 1234567890')
    process.exit(1)
  }
  startSock()
} else {
  startSock()
}

// Close database pool on exit
process.on('exit', () => pool.end())
process.on('SIGINT', () => process.exit())
