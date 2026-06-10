// POST /api/verify-entry
// Body: { txSignature, playerPubkey, tier }
// Verifies the player paid the entry fee on-chain, then issues a scoped Ably token.

const Ably = require('ably');

const HOUSE_WALLET   = '2QnrdhxXYt8ythhGYHDz6MtTZE1z2bYvbss8z3ZGj2uJ';
const HOUSE_CUT      = 0.10;
const SOLANA_RPC     = 'https://api.mainnet-beta.solana.com';
const TIER_USD       = { '1': 1, '5': 5, '10': 10 };
// Token lives 15 minutes — enough for one game session
const TOKEN_TTL_MS   = 15 * 60 * 1000;

// Fetch live SOL price — used to verify lamport amount is reasonable.
// Falls back conservatively so a stale price doesn't block legit players.
async function getLiveSolPrice() {
  try {
    const r = await fetch(
      'https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT',
      { signal: AbortSignal.timeout(3000) }
    );
    const d = await r.json();
    const p = parseFloat(d.price);
    if (p > 10 && p < 10000) return p;
  } catch (_) {}
  // CoinGecko fallback
  try {
    const r2 = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      { signal: AbortSignal.timeout(4000) }
    );
    const d2 = await r2.json();
    const p2 = d2?.solana?.usd;
    if (p2 > 10 && p2 < 10000) return p2;
  } catch (_) {}
  return 150; // safe fallback — at $150 the minimum requirement is stricter
}

// Fetch the confirmed TX from Solana RPC and return the transfer instruction list.
async function fetchTxTransfers(signature) {
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

  // Basic pubkey sanity check (base58, 32–44 chars)
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(playerPubkey)) {
    return res.status(400).json({ error: 'Invalid playerPubkey' });
  }

  let txData;
  try {
    txData = await fetchTxTransfers(txSignature);
  } catch (e) {
    return res.status(502).json({ error: 'RPC fetch failed — try again' });
  }

  if (!txData) {
    return res.status(400).json({ error: 'Transaction not found or not confirmed' });
  }

  // Transaction must have succeeded
  if (txData.meta?.err !== null && txData.meta?.err !== undefined &&
      JSON.stringify(txData.meta.err) !== 'null') {
    return res.status(400).json({ error: 'Transaction failed on-chain' });
  }

  // Parse all SystemProgram Transfer instructions
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
    return res.status(400).json({ error: 'No qualifying transfer found: must send from your wallet to house wallet' });
  }

  // Find max lamports sent in any one instruction to HOUSE_WALLET
  const lamportsSent = Math.max(...transfers.map(t => parseInt(t.parsed.info.lamports, 10) || 0));

  // Verify amount ≥ 80% of the expected 10% entry fee at live SOL price.
  // The 80% tolerance handles SOL price swings between client calculation and server check.
  const solPrice  = await getLiveSolPrice();
  const tierUsd   = TIER_USD[String(tier)];
  const expectedSol  = (tierUsd * HOUSE_CUT) / solPrice;
  const minLamports  = Math.floor(expectedSol * 0.80 * 1e9);

  if (lamportsSent < minLamports) {
    return res.status(400).json({
      error: `Payment too low: sent ${lamportsSent} lamports, need ≥ ${minLamports} (${(minLamports/1e9).toFixed(6)} SOL)`
    });
  }

  // Payment verified — issue a scoped Ably token
  const ably = new Ably.Rest(process.env.ABLY_API_KEY);

  // Token is scoped to exactly: game-{tier} channel, publish + subscribe only.
  // The player's pubkey is embedded in the clientId so cheating across sessions is traceable.
  const tokenRequest = await ably.auth.createTokenRequest({
    clientId: playerPubkey,
    ttl: TOKEN_TTL_MS,
    capability: JSON.stringify({
      [`game-${tier}`]: ['publish', 'subscribe', 'presence']
    })
  });

  return res.status(200).json({ tokenRequest, solPrice, lamportsSent });
};
