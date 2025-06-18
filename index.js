const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const QRCode = require('qrcode')
const { Boom } = require('@hapi/boom')
const fs = require('fs')
const pino = require('pino') // Add Pino logger

// Parse command line arguments
const args = process.argv.slice(2)
const usePairCode = args[0] === 'pair' && args[1]
const pairPhoneNumber = usePairCode ? args[1] : null

// Global flag to track pairing across reconnects
let globalPairingRequested = false

// Clean up any old credentials if starting fresh with pair mode
if (usePairCode && fs.existsSync('./auth_info_baileys')) {
  fs.rmSync('./auth_info_baileys', { recursive: true, force: true })
}

// Create a proper Pino logger instance
const logger = pino({
  level: 'silent',
  transport: {
    target: 'pino-pretty',
    options: { colorize: true }
  }
})

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys')
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: !usePairCode,
    logger: logger // Use the proper logger instance
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    // QR code flow (only if not using pair mode)
    if (qr && !usePairCode) {
      console.log('Scan this QR code with your WhatsApp app:')
      console.log(await QRCode.toString(qr, { type: 'terminal', small: true }))
    }

    // Pair code flow (runs ONLY once globally)
    if (
      usePairCode &&
      !globalPairingRequested &&
      (connection === 'connecting' || qr)
    ) {
      globalPairingRequested = true // Prevent future requests
      try {
        // Wait a bit longer for the connection to stabilize
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
        
        // Special handling for pairing mode
        if (usePairCode) {
          // Always reconnect in pairing mode except for invalid number errors
          shouldReconnect = statusCode !== DisconnectReason.badSession && 
                           statusCode !== DisconnectReason.invalidSession
          
          if (statusCode === DisconnectReason.unauthorized) {
            console.log('Waiting for pairing code confirmation...')
          }
        } else {
          // Standard reconnect logic for QR mode
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
        let jid
        if (usePairCode) {
          // For pair mode: send to provided number
          jid = pairPhoneNumber.replace(/\D/g, '') + '@s.whatsapp.net'
        } else {
          // For QR mode: send to the bot's own number
          jid = sock.user.id
        }
        
        await sock.sendMessage(jid, { text: 'Connected Success' })
        console.log('Sent "Connected Success" message to', jid.split('@')[0])
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
