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
const pairPhoneNumber = usePairCode ? args[1] : null;

async function startSock(pairPhoneNumber = null) {
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
      const reason = lastDisconnect?.error;
      const shouldReconnect =
        (reason instanceof Boom &&
          reason.output?.statusCode === DisconnectReason.restartRequired);

      // Print more detailed error info for pair code failures
      if (usePairCode && reason && reason.output?.statusCode === 401) {
        console.error('Failed to get pairing code: Unauthorized. Possible causes:\n' +
          '- The phone number must NOT already be linked to any WhatsApp Web session or another device.\n' +
          '- The phone number must be a valid WhatsApp account.\n' +
          '- You must wait for the connection to be ready before requesting a pairing code.\n' +
          '- Try deleting the "auth_info_baileys" folder and retry.');
      } else if (!shouldReconnect) {
        console.log('Connection closed. Reason:', reason?.output?.payload || reason || 'unknown');
      }

      if (shouldReconnect) {
        console.log('Restart required, reconnecting...');
        setTimeout(() => startSock(pairPhoneNumber), 1000);
      }
    }

    if (connection === 'open') {
      console.log('Successfully connected to WhatsApp!');
      // Send a message to the connected number on success (for pair mode)
      if (usePairCode && pairPhoneNumber) {
        try {
          const jid = pairPhoneNumber.replace(/[^0-9]/g, "") + "@s.whatsapp.net";
          await sock.sendMessage(jid, { text: "Connected Success" });
          console.log('Sent "Connected Success" message to', pairPhoneNumber);
        } catch (err) {
          console.error('Failed to send connected message:', err?.message || err);
        }
      }
    }

    // Handle Pairing Code
    // Only run once after "connecting" or "qr" event
    if (
      usePairCode &&
      pairPhoneNumber &&
      !pairingRequested &&
      (connection === "connecting" || !!qr)
    ) {
      try {
        pairingRequested = true;
        const code = await sock.requestPairingCode(pairPhoneNumber);
        console.log('Pairing code for', pairPhoneNumber, ':', code);
        console.log('Enter this code on your WhatsApp (phone number must not be linked elsewhere).');
      } catch (err) {
        // If the connection closes, we will print the error in the above connection closed block
        if (!err.message?.includes("Connection Closed")) {
          console.error('Failed to get pairing code:', err?.message || err);
        }
      }
    }
  });
}

if (usePairCode) {
  // Pairing code login mode
  if (!/^\d+$/.test(pairPhoneNumber)) {
    console.error('Phone number must be digits only, in E.164 format, no plus sign. Example: 12345678901');
    process.exit(1);
  }
  startSock(pairPhoneNumber);
} else {
  // QR code mode
  startSock();
}
