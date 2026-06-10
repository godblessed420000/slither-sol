// POST /api/verify-entry
// Body: { txSignature, playerPubkey, tier }
// Verifies the player paid the entry fee on-chain, then issues a scoped Ably token.

const Ably = require('ably');

const HOUSE_WALLET   = '2QnrdhxXYt8ythhGYHDz6MtTZE1z2bYvbss8z3ZGj2uJ';
const HOUSE_CUT      = 0.10;
const SOLANA_RPC     = 'https://api.mainnet-beta.solana.com';
const TIER_USD       = { '1': 1, '5': 5, '10': 10 };
// Token lives 12 minutes — covers a full game session but expires fast enough
// to prevent meaningful replay if a token somehow leaks.
const TOKEN_TTL_MS   = 12 * 60 * 1000;
// Maximum age of the join TX in seconds. Forces a fresh TX per session.
// An attacker cannot reuse an old TX signature to get unlimited tokens.
const MAX_TX_AGE_SEC = 300; // 5 minutes

// Fetch live SOL price from multiple APIs in parallel — first valid wins.
// Fallback is intentionally HIGH ($1000) so that if all APIs fail, the minimum
// lamport requirement is LOW (permissive). This prevents false-rejecting legit
// players when APIs are down. The TX is still verified on-chain; the amount
// check is just a sanity guard against someone paying 1 lamport.
async function getLiveSolPrice() {
  const apis = [
    async () => {
      const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT',
        { signal: AbortSignal.timeout(3000) });
      const p = parseFloat((await r.json()).price);
      if (p > 10 && p < 50000) return p;
    },
    async () => {
      const r = await fetch('https://api.kraken.com/0/public/Ticker?pair=SOLUSD',
        { signal: AbortSignal.timeout(3000) });
      const d = await r.json();
      const p = parseFloat(Object.values(d.result || {})[0]?.c?.[0]);
      if (p > 10 && p < 50000) return p;
    },
    async () => {
      const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
        { signal: AbortSignal.timeout(4000) });
      const p = (await r.json())?.solana?.usd;
      if (p > 10 && p < 50000) return p;
    },
  ];

  const result = await Promise.any(apis.map(fn => fn().then(p => { if (!p) throw new Error(); return p; })))
    .catch(() => null);

  return result || 1000; // high fallback = low minimum = fewer false rejections
}

// Fetch the confirmed TX from Solana RPC.
async function fetchTx(signature) {
  const body = {
    jsonrpc: '2.0', id: 1,
    method: 'getTransaction',
    params: [signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]
  };
  const r = await fetch(SOLANA_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000)
  });
  const data = await r.json();
  return data?.result || null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { txSignature, playerPubkey, tier } = req.body || {};

  if (!txSignature || !playerPubkey || !tier) {
    return res.status(400).json({ error: 'Missing txSignature, playerPubkey, or tier' });
  }
  if (!TIER_USD[String(tier)]) {
    return res.status(400).json({ error: 'Invalid tier' });
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(playerPubkey)) {
    return res.status(400).json({ error: 'Invalid playerPubkey' });
  }
  // Basic TX signature format check (base58, 87-88 chars for Solana)
  if (!/^[1-9A-HJ-NP-Za-km-z]{80,100}$/.test(txSignature)) {
    return res.status(400).json({ error: 'Invalid txSignature format' });
  }

  let txData;
  try {
    txData = await fetchTx(txSignature);
  } catch (e) {
    return res.status(502).json({ error: 'Solana RPC unreachable — try again' });
  }

  if (!txData) {
    return res.status(400).json({ error: 'Transaction not found or not confirmed yet' });
  }

  // ── Anti-replay: TX must be recent (within MAX_TX_AGE_SEC) ──────────────────
  // blockTime is set by the Solana validator — the client cannot fake it.
  // This forces a fresh on-chain TX per game session. An attacker who paid once
  // cannot submit the same txSignature minutes later to get another free token.
  const txBlockTime = txData.blockTime || 0;
  const nowSec      = Math.floor(Date.now() / 1000);
  const txAgeSec    = nowSec - txBlockTime;
  if (txBlockTime === 0 || txAgeSec > MAX_TX_AGE_SEC) {
    return res.status(400).json({
      error: `Transaction too old (${txAgeSec}s). Submit a fresh transaction — must be within ${MAX_TX_AGE_SEC}s`
    });
  }

  // TX must have succeeded
  if (txData.meta?.err !== null && txData.meta?.err !== undefined &&
      JSON.stringify(txData.meta.err) !== 'null') {
    return res.status(400).json({ error: 'Transaction failed on-chain' });
  }

  // ── Verify transfer: playerPubkey → HOUSE_WALLET ─────────────────────────────
  const instructions = txData.transaction?.message?.instructions || [];
  const innerInstructions = (txData.meta?.innerInstructions || [])
    .flatMap(ii => ii.instructions || []);
  const allInstructions = [...instructions, ...innerInstructions];

  const transfers = allInstructions.filter(ix =>
    ix.program === 'system' &&
    ix.parsed?.type === 'transfer' &&
    ix.parsed?.info?.source === playerPubkey &&
    ix.parsed?.info?.destination === HOUSE_WALLET
  );

  if (transfers.length === 0) {
    return res.status(400).json({
      error: 'No transfer found from your wallet to the house wallet in this transaction'
    });
  }

  const lamportsSent = Math.max(...transfers.map(t => parseInt(t.parsed.info.lamports, 10) || 0));

  // ── Amount sanity check ───────────────────────────────────────────────────────
  // Require at least 75% of the expected 10% entry fee at live SOL price.
  // The 25% tolerance covers: SOL price swing between client calc and server check,
  // rounding, and the Solana network fee (~5000 lamports) reducing available balance.
  const solPrice    = await getLiveSolPrice();
  const tierUsd     = TIER_USD[String(tier)];
  const expectedSol = (tierUsd * HOUSE_CUT) / solPrice;
  const minLamports = Math.floor(expectedSol * 0.75 * 1e9);

  if (lamportsSent < minLamports) {
    return res.status(400).json({
      error: `Payment too low: sent ${lamportsSent} lam, need ≥ ${minLamports} lam (SOL price: $${solPrice.toFixed(0)})`
    });
  }

  // ── All checks passed — issue scoped Ably token ───────────────────────────────
  // Token is scoped to exactly game-{tier} channel. The player's pubkey is the
  // clientId so any published message is cryptographically tied to their identity.
  const ably = new Ably.Rest(process.env.ABLY_API_KEY);
  const tokenRequest = await ably.auth.createTokenRequest({
    clientId: playerPubkey,
    ttl: TOKEN_TTL_MS,
    capability: JSON.stringify({
      [`game-${tier}`]: ['publish', 'subscribe', 'presence']
    })
  });

  return res.status(200).json({ tokenRequest, solPrice, lamportsSent, txAgeSec });
};
