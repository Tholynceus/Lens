import { scanB20 } from './b20.js';

const SUPABASE_URL = process.env.LENS_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.LENS_SUPABASE_ANON_KEY;
const ALCHEMY_KEY = process.env.LENS_ALCHEMY_KEY;
const BASE_RPC = ALCHEMY_KEY ? `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}` : null;

// EVM address validator — used to sanitize anything we splice into PostgREST queries.
const isAddr = (w) => /^0x[0-9a-fA-F]{40}$/.test(w);

// fetch with timeout so a slow upstream can't hang the whole serverless function.
async function fetchWithTimeout(url, options = {}, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // CORS preflight
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { username, wallet, wallet_resolve, contract } = req.query;

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

  if (!username && !wallet && !contract) return res.status(400).json({ error: 'username, wallet, or contract required' });
  try {
    let w = wallet;
    if (!username && !w && contract) {
      const c = String(contract).toLowerCase();
      if (!isAddr(c)) return res.status(400).json({ error: 'invalid contract address' });
      const rows = await sbFetch(`bankr_launches?token_address=ilike.${c}&select=deployer_wallet&limit=1`, SUPABASE_ANON_KEY);
      w = (rows && rows[0] && rows[0].deployer_wallet) ? rows[0].deployer_wallet : null;
      if (!w) {
        // not in the Bankr index — try Base's native B20 token standard
        try {
          const b20 = await scanB20(BASE_RPC, c);
          if (b20.isB20) return res.json({ success: true, data: { found: true, source: 'b20', ...b20 } });
        } catch (_) {}
        return res.json({ success: true, data: { found: false } });
      }
    }
    const data = await lookupProfile({ username, wallet: w });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// Stats for a wallet: deploy count, fee-recipient count, and resolved username.
async function walletStats(wallet) {
  const w = String(wallet).toLowerCase();
  if (!isAddr(w)) throw new Error('Invalid wallet address');

  // allSettled so one failing query doesn't nuke both.
  const [deployedR, feeR] = await Promise.allSettled([
    sbFetch(`bankr_launches?deployer_wallet=ilike.${w}&select=token_address,x_username&order=launched_at.desc`, SUPABASE_ANON_KEY),
    sbFetch(`bankr_launches?fee_recipient_wallet=ilike.${w}&select=token_address,x_username_fee&order=launched_at.desc`, SUPABASE_ANON_KEY),
  ]);
  const deployed = deployedR.status === 'fulfilled' ? deployedR.value : [];
  const feeRows = feeR.status === 'fulfilled' ? feeR.value : [];

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
  const w = String(wallet).toLowerCase();
  if (!isAddr(w)) throw new Error('Invalid wallet address');

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
  const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${path}`, {
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
  const res = await fetchWithTimeout(`https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`, {
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
  let pleaseBroTokens = []; // tokens where user is fee recipient (PleaseBro)

  if (username) {
    const u = String(username).toLowerCase();
    const uEnc = encodeURIComponent(u);
    // Tokens deployed by this user (case-insensitive: handles can be indexed with mixed casing)
    tokens = await sbFetch(
      `bankr_launches?x_username=ilike.${uEnc}&select=*&order=launched_at.desc`,
      SUPABASE_ANON_KEY
    );
    // ilike treats `_` as a single-char wildcard, so re-check an exact (case-insensitive) match in JS
    tokens = (tokens || []).filter(t => (t.x_username || '').toLowerCase() === u);
    // Tokens where user is fee recipient (PleaseBro), also case-insensitive
    pleaseBroTokens = await sbFetch(
      `bankr_launches?x_username_fee=ilike.${uEnc}&select=*&order=launched_at.desc`,
      SUPABASE_ANON_KEY
    );
    pleaseBroTokens = (pleaseBroTokens || []).filter(p => (p.x_username_fee || '').toLowerCase() === u);
    // Remove duplicates (if user is both deployer and fee recipient on same token)
    pleaseBroTokens = pleaseBroTokens.filter(p => !tokens.find(t => t.token_address === p.token_address));
    // TRUE PleaseBro only: deployer must be SOMEONE ELSE.
    // Drop any token where deployer == fee recipient (same wallet or same username),
    // even if usernames were indexed with different casing/null.
    pleaseBroTokens = pleaseBroTokens.filter(p => {
      const dw = (p.deployer_wallet || '').toLowerCase();
      const fw = (p.fee_recipient_wallet || '').toLowerCase();
      if (dw && fw && dw === fw) return false;            // same wallet = not PleaseBro
      const du = (p.x_username || '').toLowerCase();
      if (du && du === u) return false;                    // user deployed it themselves
      if (!dw && !du) return false;                        // unknown deployer = can't confirm PleaseBro
      return true;
    });
  }

  if (wallet && tokens.length === 0 && pleaseBroTokens.length === 0) {
    const w = String(wallet).toLowerCase();
    if (!isAddr(w)) throw new Error('Invalid wallet address');
    tokens = await sbFetch(
      `bankr_launches?deployer_wallet=ilike.${w}&select=*&order=launched_at.desc`,
      SUPABASE_ANON_KEY
    );
    pleaseBroTokens = await sbFetch(
      `bankr_launches?fee_recipient_wallet=ilike.${w}&select=*&order=launched_at.desc`,
      SUPABASE_ANON_KEY
    );
    pleaseBroTokens = pleaseBroTokens.filter(p => !tokens.find(t => t.token_address === p.token_address));
    // TRUE PleaseBro only: deployer wallet must differ from this wallet
    pleaseBroTokens = pleaseBroTokens.filter(p => {
      const dw = (p.deployer_wallet || '').toLowerCase();
      if (dw && dw === w) return false;                    // self-deployed
      if (!dw) return false;                               // unknown deployer = can't confirm
      return true;
    });
  }

  if (!tokens.length && !pleaseBroTokens.length) return { found: false };

  const deployerWallets = [...new Set(tokens.map(t => t.deployer_wallet).filter(Boolean))];
  let claimData = [];

  for (const w of deployerWallets.slice(0, 3)) {
    const wl = String(w).toLowerCase();
    if (!isAddr(wl)) continue;
    const rows = await sbFetch(
      `bankr_claim_history?deployer_wallet=ilike.${wl}&select=*`,
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
      const fmtDate = ts => ts ? new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null;
      sells.push({ token_address: token.token_address, token_symbol: token.token_symbol, sell_count: out.length, total_sold: fmt(total), first_sell: fmtDate(out[out.length-1].metadata?.blockTimestamp), last_sell: fmtDate(out[0].metadata?.blockTimestamp) });
    } catch {}
  }

  // ── Holders on X: which holders of this dev's tokens have a known X account ──
  const holdersOnX = await lookupHoldersOnX(tokens.slice(0, 4));

  // ── Holder stats: total count + concentration for this dev's tokens ──
  const holderStats = await computeHolderStats(tokens.slice(0, 4));

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
    holder_stats: holderStats,
    unclaimed_usd_total: totalUnclaimedUsd.toFixed(2),
  };
}

// ── Holders-on-X: for each token, fetch top holders then match wallets to known X usernames ──
async function lookupHoldersOnX(tokens) {
  if (!tokens || !tokens.length) return [];
  const out = [];
  const seenWallets = new Set();

  for (const token of tokens) {
    if (!token.token_address || !isAddr(String(token.token_address).toLowerCase())) continue;
    let holders = [];
    try {
      holders = await sbFetch(
        `token_holders?token_address=ilike.${token.token_address.toLowerCase()}&select=holder_wallet,balance&order=balance.desc&limit=100`,
        SUPABASE_ANON_KEY
      );
    } catch { continue; }
    if (!holders.length) continue;

    // collect wallets we haven't matched yet — validate as EVM addresses to avoid
    // breaking the .in.() query with malformed/injected values.
    const wallets = holders
      .map(h => (h.holder_wallet || '').toLowerCase())
      .filter(w => isAddr(w) && !seenWallets.has(w));
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

// ── Holder stats: total holder count + concentration per token ──
// Uses the indexed token_holders table (top 100 holders per token).
// Returns, for the dev's most recent token(s): total holders tracked,
// top-1 holder %, and top-10 cumulative %.
async function computeHolderStats(tokens) {
  if (!tokens || !tokens.length) return { available: false, tokens: [] };
  const out = [];

  for (const token of tokens) {
    const addr = (token.token_address || '').toLowerCase();
    if (!isAddr(addr)) continue;

    let holders = [];
    try {
      holders = await sbFetch(
        `token_holders?token_address=ilike.${addr}&select=holder_wallet,balance&order=balance.desc&limit=100`,
        SUPABASE_ANON_KEY
      );
    } catch { continue; }
    if (!holders.length) continue;

    const balances = holders
      .map(h => parseFloat(h.balance || 0))
      .filter(b => b > 0);
    if (!balances.length) continue;

    const total = balances.reduce((s, b) => s + b, 0);
    const top1 = balances[0] || 0;
    const top10 = balances.slice(0, 10).reduce((s, b) => s + b, 0);

    out.push({
      token_address: addr,
      token_symbol: token.token_symbol || null,
      holder_count: holders.length,            // tracked holders (capped at 100)
      capped: holders.length >= 100,           // true if there may be more
      top1_pct: total > 0 ? +((top1 / total) * 100).toFixed(1) : 0,
      top10_pct: total > 0 ? +((top10 / total) * 100).toFixed(1) : 0,
    });
  }

  // Concentration risk flag: any token where top holder owns a large share
  const maxTop1 = out.reduce((m, t) => Math.max(m, t.top1_pct), 0);
  const risk = maxTop1 >= 50 ? 'high' : maxTop1 >= 25 ? 'medium' : 'low';

  return {
    available: out.length > 0,
    concentration_risk: risk,
    max_top1_pct: maxTop1,
    tokens: out,
  };
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

  const r = await fetchWithTimeout(`https://api.memory.lol/v1/tw/${encodeURIComponent(clean)}`, {
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
