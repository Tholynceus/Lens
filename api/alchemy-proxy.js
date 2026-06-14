// /api/alchemy — server-side Alchemy proxy for LENS.
// Keeps ALCHEMY_KEY in Vercel env vars instead of bundling it in the extension.
// Extension POSTs { method, params }; we forward to Alchemy and return the result.
//
// Vercel env var required: LENS_ALCHEMY_KEY
// (set in Vercel dashboard → Project → Settings → Environment Variables)

const ALLOWED_METHODS = new Set([
  'eth_getTransactionByHash',
  'eth_getCode',
  'eth_getBlockByNumber',
  'alchemy_getAssetTransfers',
  'alchemy_getTokenMetadata',
  'alchemy_getTokenBalances',
]);

// fetch with timeout so a slow Alchemy response can't hang the function.
async function fetchWithTimeout(url, options = {}, ms = 9000) {
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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const key = process.env.LENS_ALCHEMY_KEY;
  if (!key) return res.status(500).json({ error: 'Alchemy key not configured on server' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { method, params } = body || {};

  // Only allow read-only methods we expect — prevents the proxy being abused
  if (!method || !ALLOWED_METHODS.has(method)) {
    return res.status(400).json({ error: 'method not allowed' });
  }

  try {
    const r = await fetchWithTimeout(`https://base-mainnet.g.alchemy.com/v2/${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || [] }),
    });
    const data = await r.json();
    return res.status(200).json(data);
  } catch (err) {
    return res.status(502).json({ error: 'alchemy upstream error', detail: err.message });
  }
}
