// POST /api/rps-auth
// Body: { playerPubkey }
// Issues an Ably token scoped to the live RPS $1 lobby: the matchmaking queue
// (presence-based) plus any rps-match-* channel (the per-match commit/reveal
// exchange). No upfront payment — the $1 wager settles peer-to-peer at match
// end (loser's client pays the winner, 10% to house), mirroring the snake
// game's non-custodial money-drop model. clientId = playerPubkey so every
// published message is cryptographically tied to the payer's identity.

const Ably = require('ably');

const TOKEN_TTL_MS = 15 * 60 * 1000;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { playerPubkey } = req.body || {};

  // Require a real Solana pubkey — guests (guest_*) have no wallet to settle
  // from and are rejected client-side before ever calling this.
  if (!playerPubkey || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(playerPubkey)) {
    return res.status(400).json({ error: 'Invalid playerPubkey' });
  }

  const ably = new Ably.Rest(process.env.ABLY_API_KEY);
  const tokenRequest = await ably.auth.createTokenRequest({
    clientId: playerPubkey,
    ttl: TOKEN_TTL_MS,
    capability: JSON.stringify({
      'rps-queue-1': ['publish', 'subscribe', 'presence'],
      'rps-match-*': ['publish', 'subscribe', 'presence']
    })
  });

  return res.status(200).json({ tokenRequest });
};
