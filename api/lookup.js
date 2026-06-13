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

async function sbFetch(path, anonKey) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { 'apikey': anonKey, 'Authorization': `Bearer ${anonKey}` }
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Supabase error: ${res.status} ${txt}`);
  }
  return res.json();
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
  let pleaseBroTokens = []; // tokens where user is fee recipient (PleaBro)

  if (username) {
    const u = username.toLowerCase();
    // Tokens deployed by this user
    tokens = await sbFetch(
      `bankr_launches?x_username=eq.${u}&select=*&order=launched_at.desc`,
      SUPABASE_ANON_KEY
    );
    // Tokens where user is fee recipient (PleaBro)
    pleaseBroTokens = await sbFetch(
      `bankr_launches?x_username_fee=eq.${u}&select=*&order=launched_at.desc`,
      SUPABASE_ANON_KEY
    );
    // Remove duplicates (if user is both deployer and fee recipient)
    pleaseBroTokens = pleaseBroTokens.filter(p => !tokens.find(t => t.token_address === p.token_address));
  }

  if (wallet && tokens.length === 0 && pleaseBroTokens.length === 0) {
    const w = wallet.toLowerCase();
    tokens = await sbFetch(
      `bankr_launches?deployer_wallet=eq.${w}&select=*&order=launched_at.desc`,
      SUPABASE_ANON_KEY
    );
    pleaseBroTokens = await sbFetch(
      `bankr_launches?fee_recipient_wallet=eq.${w}&select=*&order=launched_at.desc`,
      SUPABASE_ANON_KEY
    );
    pleaseBroTokens = pleaseBroTokens.filter(p => !tokens.find(t => t.token_address === p.token_address));
  }

  if (!tokens.length && !pleaseBroTokens.length) return { found: false };

  const deployerWallets = [...new Set(tokens.map(t => t.deployer_wallet).filter(Boolean))];
  let claimData = [];

  for (const w of deployerWallets.slice(0, 3)) {
    const rows = await sbFetch(
      `bankr_claim_history?deployer_wallet=eq.${w}&select=*`,
      SUPABASE_ANON_KEY
    );
    claimData.push(...rows);
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

  // ── Holders on X: which holders of this dev's tokens have a known X account ──
  const holdersOnX = await lookupHoldersOnX(tokens.slice(0, 4));

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
    has_please_bro: pleaseBroTokens.length > 0,
    please_bro_count: pleaseBroTokens.length,
    please_bro_tokens: pleaseBroTokens.slice(0, 5).map(t => ({
      token_address: t.token_address,
      token_name: t.token_name,
      token_symbol: t.token_symbol,
      deployer_wallet: t.deployer_wallet,
      x_username: t.x_username,
      unclaimed_token: t.unclaimed_token,
      unclaimed_weth: t.unclaimed_weth,
      unclaimed_usd: t.unclaimed_usd,
      launched_at: t.launched_at,
    })),
    tokens: tokens.slice(0, 10).map(t => ({ token_address: t.token_address, token_name: t.token_name, token_symbol: t.token_symbol, deployer_wallet: t.deployer_wallet, x_username: t.x_username, unclaimed_token: t.unclaimed_token, unclaimed_weth: t.unclaimed_weth, unclaimed_usd: t.unclaimed_usd, token_symbol_fees: t.token_symbol_fees, launched_at: t.launched_at, is_new: t.is_new })),
    claims: { has_claimed: hasClaimed, total_eth_claimed: totalClaimedEth.toFixed(4), claim_history: claimData.slice(0, 5) },
    sells: { has_sold: sells.length > 0, total_tokens_sold: sells.length, items: sells },
    has_holders_on_x: holdersOnX.length > 0,
    holders_on_x_count: holdersOnX.length,
    holders_on_x: holdersOnX,
    unclaimed_usd_total: totalUnclaimedUsd.toFixed(2),
  };
}

// ── Holders-on-X: for each token, fetch top holders then match wallets to known X usernames ──
async function lookupHoldersOnX(tokens) {
  if (!tokens || !tokens.length) return [];
  const out = [];
  const seenWallets = new Set();

  for (const token of tokens) {
    if (!token.token_address) continue;
    let holders = [];
    try {
      holders = await sbFetch(
        `token_holders?token_address=eq.${token.token_address.toLowerCase()}&select=holder_wallet,balance&order=balance.desc&limit=100`,
        SUPABASE_ANON_KEY
      );
    } catch { continue; }
    if (!holders.length) continue;

    // collect wallets we haven't matched yet
    const wallets = holders
      .map(h => (h.holder_wallet || '').toLowerCase())
      .filter(w => w && !seenWallets.has(w));
    if (!wallets.length) continue;

    // match wallets -> x_username via bankr_launches (deployer or fee recipient)
    const inList = wallets.slice(0, 100).map(w => `"${w}"`).join(',');
    let matches = [];
    try {
      matches = await sbFetch(
        `bankr_launches?or=(deployer_wallet.in.(${inList}),fee_recipient_wallet.in.(${inList}))&select=deployer_wallet,fee_recipient_wallet,x_username,x_username_fee`,
        SUPABASE_ANON_KEY
      );
    } catch { continue; }

    // build wallet -> username map
    const walletToX = {};
    for (const m of matches) {
      const dw = (m.deployer_wallet || '').toLowerCase();
      const fw = (m.fee_recipient_wallet || '').toLowerCase();
      if (dw && m.x_username && !walletToX[dw]) walletToX[dw] = m.x_username;
      if (fw && m.x_username_fee && !walletToX[fw]) walletToX[fw] = m.x_username_fee;
    }

    const balByWallet = {};
    holders.forEach(h => { balByWallet[(h.holder_wallet || '').toLowerCase()] = h.balance; });

    for (const w of wallets) {
      const x = walletToX[w];
      if (!x) continue;
      seenWallets.add(w);
      out.push({
        x_username: x,
        wallet: w,
        balance: balByWallet[w] || 0,
        token_address: token.token_address,
        token_symbol: token.token_symbol,
      });
    }
  }

  // sort by balance desc, cap at 10
  return out.sort((a, b) => parseFloat(b.balance || 0) - parseFloat(a.balance || 0)).slice(0, 10);
}
