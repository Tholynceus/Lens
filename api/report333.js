// LENS — /api/report  (crowd-sourced ingest)
// Raw PostgREST (no SDK), matches the rest of the Lens backend. Uses the service_role
// key so writes bypass RLS. Flags wallet tweets missing from the visible range as
// DELETED after MISS_THRESHOLD independent sightings.
//
// Env required: LENS_SUPABASE_URL, LENS_SUPABASE_SERVICE_KEY (service_role secret)

const SUPABASE_URL = process.env.LENS_SUPABASE_URL;
const SERVICE_KEY = process.env.LENS_SUPABASE_SERVICE_KEY;
const REST = `${SUPABASE_URL}/rest/v1`;
const MISS_THRESHOLD = 2;

function H(prefer) {
  const h = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };
  if (prefer) h.Prefer = prefer;
  return h;
}
async function sbGet(path) {
  const r = await fetch(`${REST}${path}`, { headers: H() });
  if (!r.ok) throw new Error(`GET ${r.status}: ${await r.text()}`);
  return r.json();
}
async function sbWrite(path, method, body, prefer) {
  const r = await fetch(`${REST}${path}`, { method, headers: H(prefer), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${r.status}: ${await r.text()}`);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const username = String(body.username || '').toLowerCase().replace(/^@/, '');
    if (!username || !/^[a-z0-9_]{1,20}$/.test(username)) return res.status(200).json({ success: false });

    const range = body.range || {};
    const incoming = Array.isArray(body.tweets) ? body.tweets.slice(0, 50) : [];
    const now = new Date().toISOString();

    await sbWrite('/tracked_profiles?on_conflict=username', 'POST', [{ username, active: true }], 'resolution=ignore-duplicates,return=minimal');

    const seenIds = [];
    const tweetRows = [];
    const mentionRows = [];
    for (const t of incoming) {
      const id = String(t.id || '').replace(/[^0-9]/g, '');
      if (!id) continue;
      seenIds.push(id);
      tweetRows.push({ id, username, text: String(t.text || '').slice(0, 2000), created_at: t.created_at || null, last_seen_at: now, miss_count: 0, deleted: false, deleted_at: null });
      const wallets = Array.isArray(t.wallets) ? t.wallets.slice(0, 10) : [];
      for (const w of wallets) {
        const chain = w.chain === 'sol' ? 'sol' : 'evm';
        const wallet = chain === 'evm' ? String(w.wallet || '').toLowerCase() : String(w.wallet || '');
        if (chain === 'evm' && !/^0x[a-f0-9]{40}$/.test(wallet)) continue;
        if (chain === 'sol' && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) continue;
        mentionRows.push({ username, wallet, chain, tweet_id: id });
      }
    }
    if (tweetRows.length) await sbWrite('/tweets?on_conflict=id', 'POST', tweetRows, 'resolution=merge-duplicates,return=minimal');
    if (mentionRows.length) await sbWrite('/wallet_mentions?on_conflict=wallet,tweet_id', 'POST', mentionRows, 'resolution=ignore-duplicates,return=minimal');

    // Bio / linked wallets — contract addresses shown in the profile bio (no tweet attached).
    const bioIncoming = Array.isArray(body.bio_wallets) ? body.bio_wallets.slice(0, 20) : [];
    const bioRows = [];
    const seenBio = new Set();
    for (const w of bioIncoming) {
      const chain = w.chain === 'sol' ? 'sol' : 'evm';
      const wallet = chain === 'evm' ? String(w.wallet || '').toLowerCase() : String(w.wallet || '');
      if (chain === 'evm' && !/^0x[a-f0-9]{40}$/.test(wallet)) continue;
      if (chain === 'sol' && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) continue;
      if (seenBio.has(wallet)) continue;
      seenBio.add(wallet);
      bioRows.push({ username, wallet, chain, tweet_id: null, source: 'bio' });
    }
    if (bioRows.length) {
      // partial unique index can't be an on_conflict target via PostgREST, so insert only the new ones
      const existing = await sbGet(`/wallet_mentions?username=eq.${encodeURIComponent(username)}&tweet_id=is.null&select=wallet`);
      const have = new Set((existing || []).map(r => r.wallet));
      const toInsert = bioRows.filter(r => !have.has(r.wallet));
      if (toInsert.length) await sbWrite('/wallet_mentions', 'POST', toInsert, 'return=minimal');
    }

    // Deletion detection within the reported visible range.
    if (range.oldest && range.newest) {
      const q = `/tweets?username=eq.${encodeURIComponent(username)}` +
        `&created_at=gte.${encodeURIComponent(range.oldest)}&created_at=lte.${encodeURIComponent(range.newest)}` +
        `&deleted=eq.false&select=id,miss_count`;
      const stored = await sbGet(q);
      const missing = (stored || []).filter(s => !seenIds.includes(s.id));
      for (const s of missing) {
        const mc = (s.miss_count || 0) + 1;
        const patch = mc >= MISS_THRESHOLD ? { miss_count: mc, deleted: true, deleted_at: now } : { miss_count: mc };
        await sbWrite(`/tweets?id=eq.${encodeURIComponent(s.id)}`, 'PATCH', patch, 'return=minimal');
      }
    }
    return res.status(200).json({ success: true });
  } catch (e) {
    return res.status(200).json({ success: false, error: String((e && e.message) || e) });
  }
}
