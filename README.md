# SLITHER.SOL — PvP Snake Arena on Solana

Live: https://slither-sol-deploy.vercel.app

## Wallet Addresses (already set in code)
- House wallet (10% fee receiver): `2QnrdhxXYt8ythhGYHDz6MtTZE1z2bYvbss8z3ZGj2uJ`
- Escrow wallet (1% fee receiver): `GR6sQhkukgPkskTkaE3Vns1YRDG8P2QEsaTf8e3W4UoD`

## Privy Dashboard — Exact Allowed Origins
Go to: privy.io → your app → Settings → Allowed Origins

Add ONLY these specific domains (no wildcards):
```
http://localhost
http://localhost:3000
http://localhost:5500
http://localhost:8080
https://slither-sol-deploy.vercel.app
```

Do NOT add `https://*.vercel.app` — Privy flags this as too permissive.
If you get a new Vercel preview URL, add it specifically.

## Privy Embedded Wallets Setup
1. Dashboard → Embedded Wallets → Solana
2. Enable Solana embedded wallets
3. Create on login: All users
4. Network: Mainnet
5. No prompt on signature: ON

## Deploy
Push `slither-sol-deploy/` folder to GitHub, import into Vercel.
