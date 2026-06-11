// GET /api/tx-status?sig=<base58_signature>
// Server-side proxy. The browser cannot query most Solana RPCs due to CORS.
// Races 4 reliable RPCs server-side, returns the first definitive answer.
// Response: { confirmed: true }  — TX confirmed and succeeded
//           { confirmed: false } — TX failed on-chain
//           { confirmed: null }  — status unknown (all RPCs timed out / TX not found yet)

const RPCS = [
  'https://api.mainnet-beta.solana.com',
  'https://api.mainnet.solana.com',
  'https://rpc.ankr.com/solana',
  'https://solana-rpc.publicnode.com',
];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const sig = req.query && req.query.sig;
  if (!sig || !/^[1-9A-HJ-NP-Za-km-z]{80,100}$/.test(sig)) {
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1,
    method: 'getSignatureStatuses',
    params: [[sig], { searchTransactionHistory: true }],
  });

  const fetches = RPCS.map(url =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(5000),
    })
    .then(r => r.json())
    .then(d => {
      const st = d?.result?.value?.[0];
      if (!st) throw new Error('not found');
      if (st.err) return { confirmed: false };
      if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') {
        return { confirmed: true };
      }
      throw new Error('pending');
    })
  );

  try {
    const result = await Promise.any(fetches);
    return res.status(200).json(result);
  } catch {
    return res.status(200).json({ confirmed: null });
  }
};
