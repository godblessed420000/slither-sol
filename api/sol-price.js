// GET /api/sol-price
// Server-side SOL/USD price proxy. Binance is US-blocked (451) and most
// price APIs reject CORS from the browser. This endpoint races reliable
// sources server-side and returns the first valid price.

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const apis = [
    async () => {
      const r = await fetch('https://price.jup.ag/v6/price?ids=So11111111111111111111111111111111111111112',
        { signal: AbortSignal.timeout(4000) });
      const d = await r.json();
      const p = parseFloat(d?.data?.['So11111111111111111111111111111111111111112']?.price);
      if (p > 10 && p < 5000) return p;
    },
    async () => {
      const r = await fetch('https://api.kraken.com/0/public/Ticker?pair=SOLUSD',
        { signal: AbortSignal.timeout(4000) });
      const d = await r.json();
      const p = parseFloat(Object.values(d.result || {})[0]?.c?.[0]);
      if (p > 10 && p < 5000) return p;
    },
    async () => {
      const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
        { signal: AbortSignal.timeout(5000) });
      const p = (await r.json())?.solana?.usd;
      if (p > 10 && p < 5000) return p;
    },
  ];

  try {
    const price = await Promise.any(
      apis.map(fn => fn().then(p => { if (!p) throw new Error('invalid'); return p; }))
    );
    return res.status(200).json({ price });
  } catch (e) {
    return res.status(502).json({ error: 'All price sources unavailable', price: 148 });
  }
};
