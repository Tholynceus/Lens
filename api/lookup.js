import { URL } from 'url';

const SUPABASE_URL = process.env.LENS_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.LENS_SUPABASE_ANON_KEY;
const ALCHEMY_KEY = process.env.LENS_ALCHEMY_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  const { username, wallet } = req.query;
  if (!username && !wallet) return res.status(400).json({ error: 'username or wallet required' });
  try {
    const data = await lookupProfile({ username, wallet });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

async function alchemyRpc(method, params) {
  if (!ALCHEMY_KEY) throw new Error('No Alchemy key');
  const res = await fetch(`https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || 'Alchemy RPC error');
  return json.result;
}

async function lookupProfile({ username, wallet }) {
  let tokens = [];

  if (username) {
    const url = new URL(`${SUPABASE_URL}/rest/v1/bankr_launches`);
    url.searchParams.set('or', `(x_username.eq.${username.toLowerCase()},x_username_fee.eq.${username.toLowerCase()})`);
    url.searchParams.set('select', '*');
    url.searchParams.set('order', 'launched_at.desc');
    const res = await fetch(url.toString(), {
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` }
    });
    if (res.ok) tokens = await res.json();
  }

  if (wallet && tokens.length === 0) {
    const url = new URL(`${SUPABASE_URL}/rest/v1/bankr_launches`);
    url.searchParams.set('or', `(deployer_wallet.eq.${wallet.toLowerCase()},fee_recipient_wallet.eq.${wallet.toLowerCase()})`);
    url.searchParams.set('select', '*');
    url.searchParams.set('order', 'launched_at.desc');
    const res = await fetch(url.toString(), {
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` }
    });
    if (res.ok) tokens = await res.json();
  }

  if (!tokens.length) return { found: false };

  const deployerWallets = [...new Set(tokens.map(t => t.deployer_wallet).filter(Boolean))];
  let claimData = [];

  for (const w of deployerWallets.slice(0, 3)) {
    const url = new URL(`${SUPABASE_URL}/rest/v1/bankr_claim_history`);
    url.searchParams.set('deployer_wallet', `eq.${w}`);
    url.searchParams.set('select', '*');
    const res = await fetch(url.toString(), {
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` }
    });
    if (res.ok) { const rows = await res.json(); claimData.push(...rows); }
  }

  const sells = [];
  for (const token of tokens.slice(0, 4)) {
    if (!token.deployer_wallet || !token.token_address) continue;
    try {
      const result = await alchemyRpc('alchemy_getAssetTransfers', [{
        fromAddress: token.deployer_wallet,
        contractAddresses: [token.token_address],
        category: ['erc20'],
        order: 'desc',
        withMetadata: true,
        excludeZeroValue: true,
        maxCount: '0x3e8',
      }]);
      const out = result?.transfers || [];
      if (!out.length) continue;
      const total = out.reduce((s, tx) => s + (tx.value || 0), 0);
      const fmt = n => n < 1000 ? n.toFixed(2) : n < 1e6 ? `${(n/1000).toFixed(1)}K` : `${(n/1e6).toFixed(1)}M`;
      const fmtDate = ts => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      sells.push({ token_address: token.token_address, token_symbol: token.token_symbol, sell_count: out.length, total_sold: fmt(total), first_sell: fmtDate(out[out.length-1].metadata?.blockTimestamp), last_sell: fmtDate(out[0].metadata?.blockTimestamp) });
    } catch {}
  }

  const totalUnclaimedUsd = tokens.reduce((s, t) => s + parseFloat(t.unclaimed_usd || 0), 0);
  const totalClaimedEth = claimData.reduce((s, c) => s + parseFloat(c.total_eth_claimed || 0), 0);
  const hasNewToken = tokens.some(t => t.is_new);
  const hasClaimed = claimData.some(c => parseInt(c.claim_count) > 0);

  return {
    found: true,
    token_count: tokens.length,
    has_new_token: hasNewToken,
    has_claimed: hasClaimed,
    has_sold: sells.length > 0,
    tokens: tokens.slice(0, 10).map(t => ({ token_address: t.token_address, token_name: t.token_name, token_symbol: t.token_symbol, deployer_wallet: t.deployer_wallet, x_username: t.x_username, unclaimed_token: t.unclaimed_token, unclaimed_weth: t.unclaimed_weth, unclaimed_usd: t.unclaimed_usd, token_symbol_fees: t.token_symbol_fees, launched_at: t.launched_at, is_new: t.is_new })),
    claims: { has_claimed: hasClaimed, total_eth_claimed: totalClaimedEth.toFixed(4), claim_history: claimData.slice(0, 5) },
    sells: { has_sold: sells.length > 0, total_tokens_sold: sells.length, items: sells },
    unclaimed_usd_total: totalUnclaimedUsd.toFixed(2),
  };
}
