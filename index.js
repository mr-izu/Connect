const { makeWASocket, DisconnectReason } = require('@whiskeysockets/baileys')
const QRCode = require('qrcode')
const { Boom } = require('@hapi/boom')
const { Client } = require('pg')
const crypto = require('crypto')
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

// Custom auth state manager for PostgreSQL
async function usePostgresAuthState(sessionPassword) {
  let creds = null
  let keys = {}
  let currentSessionPassword = sessionPassword

  // Load from PostgreSQL if session exists
  if (currentSessionPassword) {
    try {
      const res = await pgClient.query(
        'SELECT state FROM sessions WHERE session_password = $1',
        [currentSessionPassword]
      )
      
      if (res.rows.length > 0 && res.rows[0].state) {
        ({ creds, keys } = res.rows[0].state)
        console.log(`Loaded existing session: ${currentSessionPassword}`)
      } else {
        console.log(`No existing session found for: ${currentSessionPassword}`)
      }
    } catch (err) {
      console.error('Error loading session:', err.message)
    }
  }

  // Initialize with empty credentials if null
  if (!creds) {
    creds = {
      noiseKey: null,
      signedIdentityKey: null,
      signedPreKey: null,
      registrationId: null,
      advSecretKey: null,
      nextPreKeyId: null,
      firstPreKeyId: null,
      serverHasPreKeys: null,
      me: null
    }
  }

  // Save to PostgreSQL
  const saveCreds = async (newCreds) => {
    creds = newCreds
    if (currentSessionPassword) {
      try {
        await pgClient.query(
          `INSERT INTO sessions (session_password, state)
           VALUES ($1, $2)
           ON CONFLICT (session_password)
           DO UPDATE SET state = $2`,
          [currentSessionPassword, { creds, keys }]
        )
      } catch (err) {
        console.error('Error saving credentials:', err.message)
      }
    }
  }

  // Function to set session password after connection
  const setSessionPassword = (newPassword) => {
    currentSessionPassword = newPassword
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
    saveCreds,
    setSessionPassword
  }
}

// Generate session password with prefix
function generateSessionPassword() {
  const randomString = crypto.randomBytes(10).toString('hex')
  return `IzumieConsole~${randomString}`
}

// Parse command line arguments
const args = process.argv.slice(2)
const usePairCode = args[0] === 'pair' && args[1]
const pairPhoneNumber = usePairCode ? args[1] : null
const sessionPassword = args[2] || null // Don't generate yet

globalPairingRequested = false

async function startSock() {
  // Create auth state with proper initialization
  const authState = await usePostgresAuthState(sessionPassword)
  const { state, saveCreds, setSessionPassword } = authState
  
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
      // Only generate session password AFTER successful connection
      if (!sessionPassword) {
        const newSessionPassword = generateSessionPassword()
        setSessionPassword(newSessionPassword)
        await saveCreds(sock.authState.creds)
        console.log('\nSuccessfully connected to WhatsApp!')
        console.log(`Session Password: ${newSessionPassword}`)
      } else {
        console.log('\nSuccessfully reconnected to WhatsApp!')
      }
      
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
