const SUPABASE_URL = process.env.LENS_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.LENS_SUPABASE_ANON_KEY;
const ALCHEMY_KEY = process.env.LENS_ALCHEMY_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  const { username, wallet, wallet_resolve } = req.query;

  // Lightweight endpoint: resolve a wallet -> X username from indexed data
  if (wallet_resolve) {
    try {
      const x = await resolveWalletToX(wallet_resolve);
      return res.json({ success: true, wallet: wallet_resolve, x_username: x });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // Wallet stats: how many tokens deployed + how many as fee recipient + username
  if (req.query.stats) {
    try {
      const s = await walletStats(req.query.stats);
      return res.json({ success: true, ...s });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // Username history via memory.lol (public archive index)
  if (req.query.username_history) {
    try {
      const h = await fetchUsernameHistory(req.query.username_history);
      return res.json({ success: true, ...h });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (!username && !wallet) return res.status(400).json({ error: 'username or wallet required' });
  try {
    const data = await lookupProfile({ username, wallet });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// Stats for a wallet: deploy count, fee-recipient count, and resolved username.
async function walletStats(wallet) {
  const w = wallet.toLowerCase();
  const [deployed, feeRows] = await Promise.all([
    sbFetch(`bankr_launches?deployer_wallet=eq.${w}&select=token_address,x_username&order=launched_at.desc`, SUPABASE_ANON_KEY),
    sbFetch(`bankr_launches?fee_recipient_wallet=eq.${w}&select=token_address,x_username_fee&order=launched_at.desc`, SUPABASE_ANON_KEY),
  ]);
  let username = null;
  for (const r of deployed) { if (r.x_username) { username = r.x_username; break; } }
  if (!username) for (const r of feeRows) { if (r.x_username_fee) { username = r.x_username_fee; break; } }
  return {
    wallet: w,
    x_username: username,
    deployed_count: deployed.length,
    fee_recipient_count: feeRows.length,
    is_deployer: deployed.length > 0,
  };
}


async function resolveWalletToX(wallet) {
  const w = wallet.toLowerCase();
  const rows = await sbFetch(
    `bankr_launches?or=(deployer_wallet.eq.${w},fee_recipient_wallet.eq.${w})&select=deployer_wallet,fee_recipient_wallet,x_username,x_username_fee&limit=5`,
    SUPABASE_ANON_KEY
  );
  for (const r of rows) {
    if ((r.fee_recipient_wallet || '').toLowerCase() === w && r.x_username_fee) return r.x_username_fee;
    if ((r.deployer_wallet || '').toLowerCase() === w && r.x_username) return r.x_username;
  }
  return null;
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
      fee_share: t.fee_share,
      fee_claimable_weth: t.fee_claimable_weth,
      fee_lifetime_weth: t.fee_lifetime_weth,
      launched_at: t.launched_at,
    })),
    tokens: tokens.slice(0, 10).map(t => ({ token_address: t.token_address, token_name: t.token_name, token_symbol: t.token_symbol, deployer_wallet: t.deployer_wallet, fee_recipient_wallet: t.fee_recipient_wallet, x_username: t.x_username, x_username_fee: t.x_username_fee, unclaimed_token: t.unclaimed_token, unclaimed_weth: t.unclaimed_weth, unclaimed_usd: t.unclaimed_usd, token_symbol_fees: t.token_symbol_fees, fee_share: t.fee_share, fee_claimable_weth: t.fee_claimable_weth, fee_lifetime_weth: t.fee_lifetime_weth, fee_has_claimed: t.fee_has_claimed, fee_claimed_count: t.fee_claimed_count, deployer_is_recipient: (t.deployer_wallet && t.fee_recipient_wallet) ? (t.deployer_wallet.toLowerCase() === t.fee_recipient_wallet.toLowerCase()) : true, launched_at: t.launched_at, is_new: t.is_new })),
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

// ── Username history via memory.lol ──
// Public archive index of historical Twitter/X screen names.
// Endpoint: https://api.memory.lol/v1/tw/{username}
// Returns { accounts: [{ id, screen_names: { name: [dates...] } }] }
// Note: dates are archive observation snapshots, not exact change timestamps.
// Without auth, coverage is limited; full 12-year history needs a token.
async function fetchUsernameHistory(handle) {
  const clean = String(handle).replace(/^@/, '').trim();
  if (!clean) return { username: handle, history: [], current: null };

  const r = await fetch(`https://api.memory.lol/v1/tw/${encodeURIComponent(clean)}`, {
    headers: { 'Accept': 'application/json' },
  });
  if (!r.ok) {
    // 404 = no record found, not an error for us
    if (r.status === 404) return { username: clean, history: [], current: clean, found: false };
    throw new Error(`memory.lol ${r.status}`);
  }
  const data = await r.json();
  const accounts = Array.isArray(data.accounts) ? data.accounts : [];

  // Flatten all screen names across accounts, keep earliest+latest observed date
  const names = {};
  let accountId = null;
  for (const acc of accounts) {
    if (acc.id && !accountId) accountId = acc.id;
    const sn = acc.screen_names || {};
    for (const [name, dates] of Object.entries(sn)) {
      const ds = (Array.isArray(dates) ? dates : []).filter(Boolean).sort();
      const first = ds[0] || null;
      const last = ds[ds.length - 1] || null;
      if (!names[name]) names[name] = { name, first, last };
      else {
        if (first && (!names[name].first || first < names[name].first)) names[name].first = first;
        if (last && (!names[name].last || last > names[name].last)) names[name].last = last;
      }
    }
  }

  // Sort by last-observed date (most recent first)
  const history = Object.values(names).sort((a, b) => (b.last || '').localeCompare(a.last || ''));
  // "current" = the name with the most recent observation (best guess)
  const current = history[0]?.name || clean;
  const previous = history.filter(h => h.name.toLowerCase() !== clean.toLowerCase());

  return {
    username: clean,
    account_id: accountId,
    current,
    changed: previous.length > 0,
    count: history.length,
    history,        // full list with first/last dates
    previous,       // names other than the queried one
    found: history.length > 0,
  };
}
