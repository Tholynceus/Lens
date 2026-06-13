const SUPABASE_URL = process.env.LENS_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.LENS_SUPABASE_ANON_KEY;
const ETHERSCAN_KEY = process.env.LENS_ETHERSCAN_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { username, wallet } = req.query;
  if (!username && !wallet) return res.status(400).json({ error: 'username or wallet required' });
  try {
    const data = await lookupProfile({ username, wallet });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

async function lookupProfile({ username, wallet }) {
  let tokens = [];
  if (username) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/bankr_launches?x_username=eq.${username.toLowerCase()}&select=*&order=launched_at.desc`, {
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` }
    });
    if (res.ok) tokens = await res.json();
  }
  if (wallet && tokens.length === 0) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/bankr_launches?or=(deployer_wallet.eq.${wallet.toLowerCase()},fee_recipient_wallet.eq.${wallet.toLowerCase()})&select=*&order=launched_at.desc`, {
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` }
    });
    if (res.ok) tokens = await res.json();
  }
  if (!tokens.length) return { found: false, tokens: [], fees: null };
  const feesData = await Promise.allSettled(
    tokens.slice(0, 5).map(async t => {
      try {
        const r = await fetch(`https://api.bankr.bot/public/doppler/token-fees/${t.token_address}?days=30`);
        if (!r.ok) return null;
        const d = await r.json();
        return { token_address: t.token_address, token_name: t.token_name, token_symbol: t.token_symbol, claimed_usd: parseFloat(d.claimed?.totalUsd || 0), claimable_usd: parseFloat(d.claimable?.totalUsd || 0), claim_count: d.claimed?.count || 0 };
      } catch { return null; }
    })
  );
  const fees = feesData.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
  const sellsData = await Promise.allSettled(
    tokens.slice(0, 4).map(async t => {
      if (!t.deployer_wallet || !t.token_address) return null;
      try {
        const r = await fetch(`https://api.etherscan.io/v2/api?chainid=8453&module=account&action=tokentx&contractaddress=${t.token_address}&address=${t.deployer_wallet}&sort=desc&apikey=${ETHERSCAN_KEY}`);
        const d = await r.json();
        if (d.status !== '1') return null;
        const out = d.result.filter(tx => tx.from?.toLowerCase() === t.deployer_wallet.toLowerCase());
        if (!out.length) return null;
        const dec = parseInt(out[0].tokenDecimal || 18);
        const total = out.reduce((s, tx) => s + parseInt(tx.value) / Math.pow(10, dec), 0);
        const fmt = n => n < 1000 ? n.toFixed(2) : n < 1e6 ? `${(n/1000).toFixed(1)}K` : `${(n/1e6).toFixed(1)}M`;
        return { token_address: t.token_address, token_symbol: t.token_symbol, token_name: t.token_name, sell_count: out.length, total_sold: fmt(total), first_sell: new Date(out[out.length-1].timeStamp*1000).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}), last_sell: new Date(out[0].timeStamp*1000).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) };
      } catch { return null; }
    })
  );
  const sells = sellsData.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
  return {
    found: true,
    token_count: tokens.length,
    tokens: tokens.slice(0, 10).map(t => ({ token_address: t.token_address, token_name: t.token_name, token_symbol: t.token_symbol, launched_at: t.launched_at })),
    fees: { total_claimed_usd: fees.reduce((s,f) => s+f.claimed_usd,0).toFixed(2), total_claimable_usd: fees.reduce((s,f) => s+f.claimable_usd,0).toFixed(2), tokens: fees },
    sells: { has_sold: sells.length > 0, total_tokens_sold: sells.length, items: sells }
  };
}
