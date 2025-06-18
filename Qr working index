// WhatsApp connection demo using Baileys
// Follows: https://github.com/WhiskeySockets/baileys.wiki-site/blob/c9adbea383a54d23a5b0e05ae040aa0d0ee23be2/docs/socket/connecting.md

const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const { Boom } = require('@hapi/boom');

// Parse command line arguments
// Usage:
//   node index.js          => QR code login
//   node index.js pair 994400540665  => Pair code login with phone number

const args = process.argv.slice(2);
const usePairCode = args[0] === "pair" && args[1];

async function startSock(pairPhoneNumber) {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  let pairingRequested = false;
  let sock = makeWASocket({ auth: state });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !usePairCode) {
      // Print QR code to terminal for scanning if not using pair code mode
      console.log('Scan this QR code with your WhatsApp app:');
      console.log(await QRCode.toString(qr, { type: 'terminal', small: true }));
    }

    if (connection === 'close') {
      // Handle disconnects (restart on certain disconnect reasons)
      const shouldReconnect =
        (lastDisconnect?.error instanceof Boom &&
          lastDisconnect.error.output?.statusCode === DisconnectReason.restartRequired);

      if (shouldReconnect) {
        console.log('Restart required, reconnecting...');
        startSock(pairPhoneNumber);
      } else {
        console.log('Connection closed. Reason:', lastDisconnect?.error?.output?.payload || lastDisconnect?.error || 'unknown');
      }
    }

    if (connection === 'open') {
      console.log('Successfully connected to WhatsApp!');
      // You can send/receive messages here
    }

    // Handle Pairing Code
    if (usePairCode && pairPhoneNumber && !pairingRequested && (connection === "connecting" || !!qr)) {
      try {
        pairingRequested = true;
        const code = await sock.requestPairingCode(pairPhoneNumber);
        console.log('Pairing code for', pairPhoneNumber, ':', code);
        console.log('Enter this code on your WhatsApp (phone number must not be linked elsewhere).');
      } catch (err) {
        console.error('Failed to get pairing code:', err?.message || err);
      }
    }
  });
}

if (usePairCode) {
  // Pairing code login mode
  const phoneNumber = args[1]; // Must be in E.164 format, no plus sign
  if (!/^\d+$/.test(phoneNumber)) {
    console.error('Phone number must be digits only, in E.164 format, no plus sign. Example: 12345678901');
    process.exit(1);
  }
  startSock(phoneNumber);
} else {
  // QR code mode
  startSock();
      }
