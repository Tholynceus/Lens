// ─────────────────────────────────────────────
// LENS: token_holders cron indexer
// For each token in bankr_launches, reconstruct balances from ERC-20
// Transfer history (Alchemy) and upsert the top ~100 holders.
//
// Deploy as a Vercel cron (e.g. vercel.json -> "0 */6 * * *") or call manually.
// Requires env: LENS_SUPABASE_URL, LENS_SUPABASE_SERVICE_KEY, LENS_ALCHEMY_KEY
// (service key is needed because cron WRITES to the table)
// ─────────────────────────────────────────────

const SUPABASE_URL = process.env.LENS_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.LENS_SUPABASE_SERVICE_KEY;
const ALCHEMY_KEY = process.env.LENS_ALCHEMY_KEY;

const TOP_N = 100;            // keep top N holders per token
const MAX_TOKENS_PER_RUN = 15; // throttle tokens per cron run to limit CU usage

export default async function handler(req, res) {
  try {
    const result = await indexHolders();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`Supabase GET ${r.status}: ${await r.text()}`);
  return r.json();
}

async function sbUpsert(rows) {
  if (!rows.length) return;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/token_holders?on_conflict=token_address,holder_wallet`, {
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

async function alchemyRpc(method, params) {
  const r = await fetch(`https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'Alchemy RPC error');
  return j.result;
}

// Pull ALL transfers of a token (paginated) and net them per wallet.
async function reconstructBalances(tokenAddress) {
  const balances = {}; // wallet -> bigint-ish number
  let pageKey;
  let pages = 0;

  do {
    const params = {
      contractAddresses: [tokenAddress],
      category: ['erc20'],
      order: 'asc',
      withMetadata: false,
      excludeZeroValue: true,
      maxCount: '0x3e8', // 1000
    };
    if (pageKey) params.pageKey = pageKey;

    const result = await alchemyRpc('alchemy_getAssetTransfers', [params]);
    const transfers = result?.transfers || [];

    for (const tx of transfers) {
      const v = tx.value || 0; // Alchemy returns decimal-adjusted value
      const from = (tx.from || '').toLowerCase();
      const to = (tx.to || '').toLowerCase();
      if (from && from !== '0x0000000000000000000000000000000000000000') {
        balances[from] = (balances[from] || 0) - v;
      }
      if (to && to !== '0x0000000000000000000000000000000000000000') {
        balances[to] = (balances[to] || 0) + v;
      }
    }

    pageKey = result?.pageKey;
    pages++;
  } while (pageKey && pages < 25); // hard cap pages to bound CU per token

  // keep positive balances only, sort desc, take top N
  return Object.entries(balances)
    .filter(([, bal]) => bal > 0.000001)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_N);
}

async function indexHolders() {
  // grab distinct tokens, oldest-updated first so coverage rotates
  const tokens = await sbGet(
    `bankr_launches?select=token_address&order=launched_at.desc&limit=${MAX_TOKENS_PER_RUN}`
  );

  let tokensProcessed = 0;
  let holdersWritten = 0;
  const now = new Date().toISOString();

  for (const t of tokens) {
    const addr = (t.token_address || '').toLowerCase();
    if (!addr) continue;
    let top;
    try {
      top = await reconstructBalances(addr);
    } catch {
      continue; // skip token on error, don't fail whole run
    }
    if (!top.length) continue;

    const rows = top.map(([wallet, bal], i) => ({
      token_address: addr,
      holder_wallet: wallet,
      balance: bal,
      rank: i + 1,
      last_updated: now,
    }));

    await sbUpsert(rows);
    tokensProcessed++;
    holdersWritten += rows.length;
  }

  return { tokensProcessed, holdersWritten };
}
