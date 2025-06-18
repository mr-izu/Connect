const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const QRCode = require('qrcode')
const { Boom } = require('@hapi/boom')
const fs = require('fs')

// Global flag to track pairing across reconnects
let globalPairingRequested = false;

// ... (args parsing and cleanup code remains the same)

async function startSock() { // Remove parameter
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')
  const sock = makeWASocket({ 
    auth: state,
    printQRInTerminal: !usePairCode // Auto-print QR if not pairing
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
        await new Promise(r => setTimeout(r, 1500))
        const code = await sock.requestPairingCode(pairPhoneNumber)
        console.log('Pairing code for', pairPhoneNumber, ':', code)
        console.log('Enter this code on your WhatsApp (phone number must not be linked elsewhere).')
      } catch (err) {
        console.error('Pairing failed:', err.message)
      }
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error
      const shouldReconnect = reason instanceof Boom && 
        reason.output?.statusCode === DisconnectReason.restartRequired

      // Handle specific pairing errors
      if (reason?.output?.statusCode === DisconnectReason.unauthorized) {
        console.error(
          'Authorization failed:\n' +
          '- Number must NOT be linked elsewhere\n' +
          '- Valid WhatsApp account required\n' +
          '- Delete "auth_info_baileys" and retry'
        )
        return // Don't reconnect
      }

      console.log('Connection closed:', reason?.output?.payload || reason || 'unknown')
      
      if (shouldReconnect) {
        console.log('Restart required, reconnecting...')
        setTimeout(startSock, 1000) // Reconnect without pairing flow
      }
    }

    if (connection === 'open') {
      console.log('Successfully connected!')
      if (usePairCode) {
        try {
          const jid = pairPhoneNumber.replace(/\D/g, '') + '@s.whatsapp.net'
          await sock.sendMessage(jid, { text: 'Connected Success' })
          console.log('Sent confirmation to', pairPhoneNumber)
        } catch (err) {
          console.error('Failed to send message:', err.message)
        }
      }
    }
  })
}

// Start logic remains the same
if (usePairCode) {
  if (!/^\d+$/.test(pairPhoneNumber)) {
    console.error('Invalid number. Use digits only (e.g., 1234567890)')
    process.exit(1)
  }
  startSock()
} else {
  startSock()
}
