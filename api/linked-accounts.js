// LENS — /api/linked-accounts?username=<handle>
// Sockpuppet / network detection: returns OTHER X profiles that mention the same
// PERSONAL wallet(s) (EOAs) as this profile.
//
// IMPORTANT: token contract addresses (CAs) are excluded from the linking key.
// A shared token CA just means several accounts hold / shill the same token — it
// is NOT evidence that the accounts are alts. Clustering on a CA produces false
// positives (e.g. when scanning a project's own handle, every co-holder of its
// token gets flagged as "linked"). Only a shared EOA hints at alts / a coordinated
// promo network. This mirrors the EOA-only rule already used by Cabal clustering.
//
// Env required: LENS_SUPABASE_URL, LENS_SUPABASE_SERVICE_KEY, LENS_ALCHEMY_KEY

const SUPABASE_URL = process.env.LENS_SUPABASE_URL;
const SERVICE_KEY = process.env.LENS_SUPABASE_SERVICE_KEY;
const ALCHEMY_KEY = process.env.LENS_ALCHEMY_KEY;
const REST = `${SUPABASE_URL}/rest/v1`;
const BASE_RPC = ALCHEMY_KEY ? `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}` : null;

function H() {
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };
}

const isEvm = (w) => /^0x[a-f0-9]{40}$/.test(w);

// On-chain check: a wallet that has bytecode is a contract (token CA, router,
// multisig…), never a personal EOA. Returns the subset of `wallets` that are
// contracts, so the caller can drop them from the linking key. EVM only — Solana
// mints aren't checked here (no Solana RPC configured); the common FP is a Base CA.
async function evmContractSet(wallets) {
  const out = new Set();
  if (!BASE_RPC) return out; // no key -> cannot verify; caller handles fallback
  const evm = wallets.filter(isEvm);
  await Promise.allSettled(evm.map(async (w) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    try {
      const r = await fetch(BASE_RPC, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'eth_getCode', params: [w, 'latest'] }),
      });
      const j = await r.json();
      const code = String((j && j.result) || '0x');
      if (code && code !== '0x' && code !== '0x0') out.add(w);
    } catch (_) {
      // transient RPC error: leave unverified (treated as EOA). Rare and self-heals.
    } finally {
      clearTimeout(t);
    }
  }));
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const username = String((req.query && req.query.username) || '').toLowerCase().replace(/^@/, '');
  if (!username) return res.status(200).json({ success: false, linked: [] });

  try {
    // 1) this profile's wallets
    const r1 = await fetch(`${REST}/wallet_mentions?username=eq.${encodeURIComponent(username)}&select=wallet`, { headers: H() });
    if (!r1.ok) throw new Error(`mine ${r1.status}`);
    const mine = await r1.json();
    const wallets = [...new Set((mine || []).map(m => String(m.wallet || '').toLowerCase()).filter(Boolean))];
    if (!wallets.length) return res.status(200).json({ success: true, linked: [], wallets: 0, total_accounts: 0 });

    // 1b) drop contract addresses (token CAs etc.) — never cluster on a shared CA
    const contracts = await evmContractSet(wallets);
    const eoaWallets = wallets.filter(w => !contracts.has(w));
    if (!eoaWallets.length) {
      // the profile only ever mentioned contract addresses -> nothing personal to link on
      return res.status(200).json({
        success: true, wallets: wallets.length, eoa_wallets: 0,
        contracts_excluded: contracts.size, total_accounts: 0, linked: [],
      });
    }

    // 2) everyone who mentions those same PERSONAL wallets
    const inList = eoaWallets.map(w => `"${w}"`).join(',');
    const r2 = await fetch(`${REST}/wallet_mentions?wallet=in.(${encodeURIComponent(inList)})&select=username,wallet`, { headers: H() });
    if (!r2.ok) throw new Error(`others ${r2.status}`);
    const rows = await r2.json();

    // 3) group other usernames per wallet (exclude self)
    const byWallet = new Map();
    const allAccounts = new Set();
    for (const row of rows || []) {
      const w = String(row.wallet || '').toLowerCase();
      const u = String(row.username || '').toLowerCase();
      if (!w || !u || u === username) continue;
      if (contracts.has(w)) continue; // safety: never group on a contract
      if (!byWallet.has(w)) byWallet.set(w, new Set());
      byWallet.get(w).add(u);
      allAccounts.add(u);
    }

    const linked = [];
    for (const [wallet, set] of byWallet.entries()) {
      const accounts = [...set];
      if (!accounts.length) continue;
      // heuristic: a personal wallet shared by a small cluster looks like alts/network;
      // shared by a large crowd usually means a popular / widely-quoted wallet.
      const tag = accounts.length >= 12 ? 'crowd' : 'cluster';
      linked.push({ wallet, accounts: accounts.slice(0, 12), count: accounts.length, tag });
    }
    // smallest clusters first (more suspicious), crowds last
    linked.sort((a, b) => a.count - b.count);

    return res.status(200).json({
      success: true,
      wallets: wallets.length,
      eoa_wallets: eoaWallets.length,
      contracts_excluded: contracts.size,
      total_accounts: allAccounts.size,
      linked,
    });
  } catch (e) {
    return res.status(200).json({ success: false, error: String(e && e.message || e), linked: [] });
  }
}
