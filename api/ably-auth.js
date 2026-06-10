// POST /api/ably-auth
// Body: { playerPubkey }
// Issues an Ably token for the free tier (no payment required).

const Ably = require('ably');

const TOKEN_TTL_MS = 15 * 60 * 1000;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { playerPubkey } = req.body || {};

  if (!playerPubkey || typeof playerPubkey !== 'string' || playerPubkey.length < 4) {
    return res.status(400).json({ error: 'Missing playerPubkey' });
  }

  const ably = new Ably.Rest(process.env.ABLY_API_KEY);

  const tokenRequest = await ably.auth.createTokenRequest({
    clientId: playerPubkey,
    ttl: TOKEN_TTL_MS,
    capability: JSON.stringify({
      'game-free': ['publish', 'subscribe', 'presence']
    })
  });

  return res.status(200).json({ tokenRequest });
};
