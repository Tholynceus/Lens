// api/deploy.js
// Routes a token launch to Bankr or Clanker. Keys stay server-side, never in the frontend.
//
// NOTE on Clanker: you do NOT need this backend for Clanker. The frontend deploys Clanker
// on-chain with the connected wallet (clanker-sdk, no API key). This Clanker branch is only
// for the optional "hosted" API path, which needs an x-api-key you must request from the
// Clanker team. For most setups: leave CLANKER_API_KEY empty and let Clanker deploy on-chain.
//
// ENV VARS to set on the Lens project (Vercel > Settings > Environment Variables):
//   BANKR_API_KEY       = bk_usr_...        ← self-serve wallet key from bankr.bot/api (easy path)
//   BANKR_PARTNER_KEY   = bk_ptr_...        (optional, org partner key, only if approved)
//   CLANKER_API_KEY     = ...               (optional, only for hosted Clanker deploys)
// the Bankr branch auto-detects which header to use from the key prefix.
//
// The frontend (markets.html) POSTs:
//   { launchpad: 'bankr' | 'clanker', name, symbol, image, description, creator, tweet, website }
// and gets back: { launchpad, address, raw }

export default async function handler(req, res) {
  // CORS so lnsx.io can call this. Lock the origin down to your domain in production.
  res.setHeader('Access-Control-Allow-Origin', '*'); // e.g. 'https://lnsx.io'
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { launchpad = 'bankr', name, symbol, image, description, creator, tweet, website } = body;

    if (!name || !symbol) return res.status(400).json({ error: 'name and symbol are required' });
    if (!creator || !/^0x[a-fA-F0-9]{40}$/.test(creator)) {
      return res.status(400).json({ error: 'a valid creator wallet address is required' });
    }

    // ---------- CLANKER ----------
    if (launchpad === 'clanker') {
      const key = process.env.CLANKER_API_KEY;
      if (!key) return res.status(500).json({ error: 'CLANKER_API_KEY is not set on the server' });

      const requestKey = (globalThis.crypto?.randomUUID?.() ||
        (Date.now().toString(36) + Math.random().toString(36).slice(2))).replace(/-/g, '').slice(0, 32);

      const r = await fetch('https://www.clanker.world/api/tokens/deploy/v4', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({
          token: {
            name,
            symbol,
            image: image || '',
            tokenAdmin: creator,
            description: description || '',
            socialMediaUrls: [website, tweet].filter(Boolean),
            requestKey
          },
          // route 100% of fees to the creator. tune to taste (rewardsToken: 'Both' | 'Clanker' | 'Paired')
          rewards: [{ admin: creator, recipient: creator, allocation: 100, rewardsToken: 'Both' }]
        })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.error) {
        return res.status(r.status || 502).json({ error: data.error || 'clanker deploy failed', detail: data });
      }
      return res.status(200).json({ launchpad: 'clanker', address: data.expectedAddress, message: data.message, raw: data });
    }

    // ---------- BANKR (default) ----------
    // accepts either a self-serve wallet key (bk_usr_, header X-API-Key)
    // or an org partner key (bk_ptr_, header X-Partner-Key). auto-detected by prefix.
    const key = process.env.BANKR_API_KEY || process.env.BANKR_PARTNER_KEY;
    if (!key) return res.status(500).json({ error: 'BANKR_API_KEY (bk_usr_...) is not set on the server' });

    const isPartner = key.startsWith('bk_ptr_');
    const authHeader = isPartner ? { 'X-Partner-Key': key } : { 'X-API-Key': key };

    const payload = {
      tokenName: name,
      tokenSymbol: symbol,
      // image/tweet/website are best-effort optional. confirm exact names in the
      // interactive reference: docs.bankr.bot/token-launching/api-reference/deploy-token-launch
      image: image || undefined,
      tweet: tweet || undefined,
      website: website || undefined
    };
    // partner keys require feeRecipient; wallet keys default to the key's wallet but
    // still accept an override so creator fees can route to the connected wallet
    if (isPartner || creator) payload.feeRecipient = { type: 'wallet', value: creator };

    const r = await fetch('https://api.bankr.bot/token-launches/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify(payload)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) {
      return res.status(r.status || 502).json({ error: data.error || 'bankr deploy failed', detail: data });
    }
    const address = data.tokenAddress || data.address || (data.token && data.token.address) || null;
    return res.status(200).json({ launchpad: 'bankr', address, raw: data });

  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
