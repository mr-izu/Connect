const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require('@whiskeysockets/baileys')
const QRCode = require('qrcode')
const { Boom } = require('@hapi/boom')
const fs = require('fs')
const path = require('path')
const pino = require('pino')

// Parse CLI arguments
const args = process.argv.slice(2)
const usePairCode = args[0] === 'pair' && args[1]
const pairPhoneNumber = usePairCode ? args[1] : null

const AUTH_DIR = './auth_info_baileys'
let globalPairingRequested = false

// Clean up old auth state if pairing
if (usePairCode && fs.existsSync(AUTH_DIR)) {
  fs.rmSync(AUTH_DIR, { recursive: true, force: true })
}

// Logger setup
const logger = pino({
  level: 'silent',
  transport: {
    target: 'pino-pretty',
    options: { colorize: true }
  }
})

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: !usePairCode,
    logger
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    // Show QR code in terminal
    if (qr && !usePairCode) {
      console.log('📸 Scan this QR code with WhatsApp:')
      console.log(await QRCode.toString(qr, { type: 'terminal', small: true }))
    }

    // Pairing flow
    if (
      usePairCode &&
      !globalPairingRequested &&
      (connection === 'connecting' || qr)
    ) {
      globalPairingRequested = true
      try {
        await new Promise(r => setTimeout(r, 3000))
        const code = await sock.requestPairingCode(pairPhoneNumber)
        console.log('\n📲 Pairing code for', pairPhoneNumber, ':', code)
        console.log('⚡ Enter this code in WhatsApp within 2 minutes.\n')
      } catch (err) {
        console.error('❌ Pairing failed:', err.message)
      }
    }

    // Disconnect logic
    if (connection === 'close') {
      const reason = lastDisconnect?.error
      let shouldReconnect = false

      if (reason instanceof Boom) {
        const statusCode = reason.output?.statusCode

        if (usePairCode) {
          shouldReconnect = statusCode !== DisconnectReason.badSession &&
                            statusCode !== DisconnectReason.invalidSession
          if (statusCode === DisconnectReason.unauthorized) {
            console.log('⏳ Waiting for pairing confirmation...')
          }
        } else {
          shouldReconnect = statusCode === DisconnectReason.restartRequired
        }
      }

      if (shouldReconnect) {
        console.log('🔄 Reconnecting...')
        setTimeout(startSock, 2000)
      } else {
        console.log('❌ Connection closed:', reason?.output?.payload || reason || 'unknown')
      }
    }

    // Successful connection
    if (connection === 'open') {
      console.log('✅ Successfully connected to WhatsApp!')

      try {
        const jid = usePairCode
          ? pairPhoneNumber.replace(/\D/g, '') + '@s.whatsapp.net'
          : sock.user.id

        // 1. Send "Connected Successfully" message
        await sock.sendMessage(jid, { text: '✅ Connected Successfully!' })
        console.log('📨 Sent confirmation to', jid)

        // 2. Read and send session JSON
        const credsPath = path.join(AUTH_DIR, 'creds.json')
        const keysPath = path.join(AUTH_DIR, 'keys')

        if (fs.existsSync(credsPath)) {
          const credsJson = fs.readFileSync(credsPath, 'utf-8')
          await sock.sendMessage(jid, {
            text: `🗝️ Session creds:\n\`\`\`${credsJson}\`\`\``
          })
        }

        if (fs.existsSync(keysPath)) {
          const keyFiles = fs.readdirSync(keysPath)
          for (const file of keyFiles) {
            const filePath = path.join(keysPath, file)
            const keyData = fs.readFileSync(filePath, 'utf-8')
            await sock.sendMessage(jid, {
              text: `🔐 ${file}:\n\`\`\`${keyData}\`\`\``
            })
          }
        }

        // 3. Delete session from local storage
        if (fs.existsSync(AUTH_DIR)) {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true })
          console.log('🧹 Cleared local session storage.')
        }

      } catch (err) {
        console.error('❌ Failed to send session or message:', err.message)
      }
    }
  })
}

// Entry point
if (usePairCode) {
  if (!pairPhoneNumber || !/^\d{10,15}$/.test(pairPhoneNumber)) {
    console.error('❌ Invalid phone number. Must be 10-15 digits, no +')
    process.exit(1)
  }
  startSock()
} else {
  startSock()
}
