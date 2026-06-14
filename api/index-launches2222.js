const SUPABASE_URL = process.env.LENS_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.LENS_SUPABASE_SERVICE_KEY;
const ALCHEMY_KEY = process.env.LENS_ALCHEMY_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const HOLDER_TOP_N = 100;            // keep top N holders per token
const HOLDER_TOKENS_PER_RUN = 8;     // tokens to index holders for, per holder-run
const HOLDER_RUN_EVERY_MIN = 360;    // only run holder indexing roughly every N minutes

// fetch with timeout so a slow upstream can't hang the whole serverless function.
async function fetchWithTimeout(url, options = {}, ms = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  // Hard guard: if CRON_SECRET isn't configured, refuse — never accept "Bearer undefined".
  if (!CRON_SECRET || req.headers.authorization !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const results = await indexLaunches();
    let holders = { skipped: true };
    // run holder indexing on schedule (every 6h UTC) OR when forced via ?holders=1
    const forced = req.query?.holders === '1';
    if (forced || shouldRunHolders()) {
      try { holders = await indexHolders(); }
      catch (e) { holders = { error: e.message }; }
    }
    res.json({ success: true, ...results, holders });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// Run holders only in the first 5-min slot of every 6th hour (00:00, 06:00, 12:00, 18:00 UTC)
function shouldRunHolders() {
  const d = new Date();
  return d.getUTCHours() % 6 === 0 && d.getUTCMinutes() < 5;
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

async function indexLaunches() {
  const res = await fetchWithTimeout('https://api.bankr.bot/token-launches?limit=100');
  if (!res.ok) throw new Error('Bankr API failed');
  const listData = await res.json();
  const launches = Array.isArray(listData) ? listData : (listData.launches || []);
  let indexed = 0;
  let failed = 0;
  const now = new Date().toISOString();
  for (const launch of launches) {
    // Per-launch isolation: one bad row must NOT abort the whole batch.
    try {
      const tokenAddress = (launch.tokenAddress || launch.address || '').toLowerCase();
      if (!tokenAddress) continue;
      const deployerWallet = (launch.deployer?.walletAddress || '').toLowerCase();
      const feeRecipientWallet = (launch.feeRecipient?.walletAddress || '').toLowerCase();
      const xUsername = (launch.deployer?.xUsername || '').toLowerCase();
      const xUsernameFee = (launch.feeRecipient?.xUsername || '').toLowerCase();
      const launchedAt = launch.timestamp ? new Date(launch.timestamp).toISOString() : now;
      const isNew = launch.timestamp ? (Date.now() - launch.timestamp) < 24 * 60 * 60 * 1000 : false;
      const unclaimedFees = launch.unclaimedFees || null;
      const row = {
        token_address: tokenAddress,
        token_name: launch.tokenName || launch.name,
        token_symbol: launch.tokenSymbol || launch.symbol,
        deployer_wallet: deployerWallet || null,
        fee_recipient_wallet: feeRecipientWallet || null,
        x_username: xUsername || null,
        x_username_fee: xUsernameFee || null,
        unclaimed_token: unclaimedFees?.tokenAmount || '0',
        unclaimed_weth: unclaimedFees?.wethAmount || '0',
        unclaimed_usd: parseFloat(unclaimedFees?.usdValue || 0),
        token_symbol_fees: unclaimedFees?.tokenSymbol || launch.tokenSymbol,
        launched_at: launchedAt,
        is_new: isNew,
        updated_at: now,
      };
      await supabaseUpsert('bankr_launches', row);
      if (deployerWallet) {
        await checkAndSaveClaims(deployerWallet, tokenAddress, launch.tokenSymbol);
      }
      // fetch fee structure (share %, claimable, lifetime) for the fee recipient
      const feeWallet = feeRecipientWallet || deployerWallet;
      if (feeWallet) {
        await saveFeeStructure(tokenAddress, feeWallet);
      }
      indexed++;
    } catch (e) {
      failed++;
      // continue with the next launch
    }
  }
  return { indexed, failed, total: launches.length };
}

async function checkAndSaveClaims(wallet, tokenAddress, tokenSymbol) {
  try {
    // NOTE: this counts ALL incoming internal ETH transfers to `wallet`, not only
    // Bankr fee claims. If total_eth_claimed looks inflated, filter by the Bankr
    // fee contract as the `fromAddress` here.
    const result = await alchemyRpc('alchemy_getAssetTransfers', [{
      toAddress: wallet,
      category: ['internal'],
      order: 'desc',
      withMetadata: true,
      excludeZeroValue: true,
      maxCount: '0x3e8',
    }]);
    const claims = (result?.transfers || []).filter(tx => (tx.value || 0) > 0);
    if (!claims.length) return;
    const totalEth = claims.reduce((s, tx) => s + (tx.value || 0), 0);
    const lastClaim = new Date(claims[0].metadata?.blockTimestamp || Date.now()).toISOString();
    await supabaseUpsert('bankr_claim_history', {
      deployer_wallet: wallet,
      token_address: tokenAddress,
      token_symbol: tokenSymbol,
      claim_count: claims.length,
      total_eth_claimed: totalEth.toFixed(6),
      last_claimed_at: lastClaim,
      updated_at: new Date().toISOString(),
    });
  } catch (e) {}
}

async function saveFeeStructure(tokenAddress, wallet) {
  try {
    const r = await fetchWithTimeout(`https://api.bankr.bot/public/doppler/token-fees/${tokenAddress}?address=${wallet}&days=30`);
    if (!r.ok) return;
    const data = await r.json();
    const tok = (data.tokens || [])[0];
    if (!tok) return;
    const patch = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/bankr_launches?token_address=eq.${tokenAddress.toLowerCase()}`, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        fee_share: tok.share || null,
        fee_claimable_weth: tok.claimable?.token0 || null,
        fee_lifetime_weth: data.lifetimeEarnedWeth || null,
        fee_initializer: tok.initializer || null,
        fee_updated_at: new Date().toISOString(),
      }),
    });
    if (!patch.ok) throw new Error(`fee PATCH ${patch.status}: ${await patch.text()}`);
  } catch (e) {}
}

async function supabaseUpsert(table, row) {
  const r = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates',
    },
    body: JSON.stringify(row),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Supabase upsert ${table} ${r.status}: ${txt}`);
  }
}

// ─────────────────────────────────────────────
// Holder indexing (merged from cron-holders)
// Reconstructs top holders per token from ERC-20 transfer history.
// ─────────────────────────────────────────────

async function sbGet(path) {
  const r = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`Supabase GET ${r.status}: ${await r.text()}`);
  return r.json();
}

async function sbUpsertHolders(rows) {
  if (!rows.length) return;
  const r = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/token_holders?on_conflict=token_address,holder_wallet`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`Supabase upsert ${r.status}: ${await r.text()}`);
}

async function reconstructBalances(tokenAddress) {
  const balances = {};
  let pageKey;
  let pages = 0;
  do {
    const params = {
      contractAddresses: [tokenAddress],
      category: ['erc20'],
      order: 'asc',
      withMetadata: false,
      excludeZeroValue: true,
      maxCount: '0x3e8',
    };
    if (pageKey) params.pageKey = pageKey;
    const result = await alchemyRpc('alchemy_getAssetTransfers', [params]);
    const transfers = result?.transfers || [];
    for (const tx of transfers) {
      const v = tx.value || 0;
      const from = (tx.from || '').toLowerCase();
      const to = (tx.to || '').toLowerCase();
      if (from && from !== '0x0000000000000000000000000000000000000000') balances[from] = (balances[from] || 0) - v;
      if (to && to !== '0x0000000000000000000000000000000000000000') balances[to] = (balances[to] || 0) + v;
    }
    pageKey = result?.pageKey;
    pages++;
  } while (pageKey && pages < 25);

  return Object.entries(balances)
    .filter(([, bal]) => bal > 0.000001)
    .sort((a, b) => b[1] - a[1])
    .slice(0, HOLDER_TOP_N);
}

async function indexHolders() {
  const tokens = await sbGet(
    `bankr_launches?select=token_address&order=launched_at.desc&limit=${HOLDER_TOKENS_PER_RUN}`
  );
  let tokensProcessed = 0;
  let holdersWritten = 0;
  const now = new Date().toISOString();
  for (const t of tokens) {
    const addr = (t.token_address || '').toLowerCase();
    if (!addr) continue;
    let top;
    try { top = await reconstructBalances(addr); }
    catch { continue; }
    if (!top.length) continue;
    const rows = top.map(([wallet, bal], i) => ({
      token_address: addr,
      holder_wallet: wallet,
      balance: bal,
      rank: i + 1,
      last_updated: now,
    }));
    try { await sbUpsertHolders(rows); }
    catch { continue; }
    tokensProcessed++;
    holdersWritten += rows.length;
  }
  return { tokensProcessed, holdersWritten };
}
