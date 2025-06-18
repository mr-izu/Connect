const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const QRCode = require('qrcode')
const { Boom } = require('@hapi/boom')
const fs = require('fs')
const path = require('path')

// Parse command line arguments
const args = process.argv.slice(2)
const usePairCode = args[0] === 'pair' && args[1]
const pairPhoneNumber = usePairCode ? args[1] : null

// Clean up any old credentials if starting fresh with pair mode
if (usePairCode && fs.existsSync('./auth_info_baileys')) {
  fs.rmSync('./auth_info_baileys', { recursive: true, force: true })
}

async function startSock(pairPhoneNumber = null) {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')
  const sock = makeWASocket({ auth: state })
  let pairingInProgress = false

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
      !pairingInProgress &&
      (connection === 'connecting' || !!qr)
    ) {
      pairingInProgress = true
      try {
        // Wait a tiny bit for handshake to finish
        await new Promise((r) => setTimeout(r, 1500))
        const code = await sock.requestPairingCode(pairPhoneNumber)
        console.log('Pairing code for', pairPhoneNumber, ':', code)
        console.log(
          'Enter this code on your WhatsApp (phone number must not be linked elsewhere).'
        )
      } catch (err) {
        pairingInProgress = false
        if (
          err.message?.includes('Connection Closed') ||
          err.message?.includes('closed')
        ) {
          // Silent, will be handled by connection.close
        } else {
          console.error('Failed to get pairing code:', err?.message || err)
        }
      }
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error
      const shouldReconnect =
        reason instanceof Boom &&
        reason.output?.statusCode === DisconnectReason.restartRequired

      if (usePairCode && reason && reason.output?.statusCode === 401) {
        console.error(
          'Failed to get pairing code: Unauthorized. Possible causes:\n' +
            '- The phone number must NOT already be linked to any WhatsApp Web session or another device.\n' +
            '- The phone number must be a valid WhatsApp account.\n' +
            '- Try deleting the "auth_info_baileys" folder and retry.'
        )
      } else if (!shouldReconnect) {
        console.log(
          'Connection closed. Reason:',
          reason?.output?.payload || reason || 'unknown'
        )
      }

      if (shouldReconnect) {
        console.log('Restart required, reconnecting...')
        setTimeout(() => startSock(pairPhoneNumber), 1000)
      }
    }

    if (connection === 'open') {
      console.log('Successfully connected to WhatsApp!')
      // Send a message to the connected number on success (for pair mode)
      if (usePairCode && pairPhoneNumber) {
        try {
          const jid = pairPhoneNumber.replace(/[^0-9]/g, '') + '@s.whatsapp.net'
          await sock.sendMessage(jid, { text: 'Connected Success' })
          console.log('Sent "Connected Success" message to', pairPhoneNumber)
        } catch (err) {
          console.error('Failed to send connected message:', err?.message || err)
        }
      }
    }
  })
}

if (usePairCode) {
  if (!/^\d+$/.test(pairPhoneNumber)) {
    console.error(
      'Phone number must be digits only, in E.164 format, no plus sign. Example: 12345678901'
    )
    process.exit(1)
  }
  startSock(pairPhoneNumber)
} else {
  startSock()
}
