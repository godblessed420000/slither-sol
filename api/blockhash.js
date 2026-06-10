// GET /api/blockhash
// Server-side proxy for getLatestBlockhash.
// The browser cannot call most Solana RPCs directly (CORS policy).
// This endpoint races several reliable RPC nodes server-side and returns
// a guaranteed-fresh blockhash for the client to use in transaction building.

const RPCS = [
  'https://api.mainnet-beta.solana.com',
  'https://api.mainnet.solana.com',
  'https://rpc.ankr.com/solana',
  'https://solana-rpc.publicnode.com',
  'https://solana.drpc.org',
];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1,
    method: 'getLatestBlockhash',
    params: [{ commitment: 'confirmed' }],
  });

  const fetches = RPCS.map(url =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(6000),
    })
    .then(r => r.json())
    .then(d => {
      const v = d?.result?.value;
      if (v?.blockhash && v?.lastValidBlockHeight) return v;
      throw new Error('no blockhash');
    })
  );

  try {
    const result = await Promise.any(fetches);
    return res.status(200).json({
      blockhash: result.blockhash,
      lastValidBlockHeight: result.lastValidBlockHeight,
    });
  } catch (e) {
    return res.status(502).json({ error: 'All Solana RPC endpoints unavailable — try again' });
  }
};
