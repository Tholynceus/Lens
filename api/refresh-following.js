// LENS — POST/GET /api/refresh-following
// Refreshes smart accounts' following lists (via twitterapi.io) into Supabase.
// Modes:
//   ?only=<handle>  → refresh just that account
//   ?limit=N        → refresh the N least-recently-refreshed accounts (default 5)
// The weekly/scheduled cron (no params) processes the oldest 5 each run, rotating
// through all accounts over time — no manual work needed.
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.LENS_SUPABASE_URL,
  process.env.LENS_SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);
const TWITTERAPI_KEY = process.env.TWITTERAPI_KEY;

// ─── PROVIDER: twitterapi.io ───────────────────────────────
async function fetchFollowing(handle) {
  const out = [];
  let cursor = '';
  do {
    const url = new URL('https://api.twitterapi.io/twitter/user/followings');
    url.searchParams.set('userName', handle);
    url.searchParams.set('pageSize', '200');
    if (cursor) url.searchParams.set('cursor', cursor);
    const r = await fetch(url, { headers: { 'X-API-Key': TWITTERAPI_KEY } });
    if (r.status === 429) throw new Error('rate_limited');
    const j = await r.json();
    if (j.status === 'error') throw new Error(j.message || 'api_error');
    (j.followings || []).forEach((u) => {
      const h = String(u.userName || '').toLowerCase();
      if (h) out.push({ handle: h, id: u.id || null });
    });
    cursor = j.has_next_page ? (j.next_cursor || '') : '';
  } while (cursor && out.length < 8000);
  return out;
}
// ───────────────────────────────────────────────────────────

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

async function refreshOne(a) {
  const following = await fetchFollowing(a.handle);
  if (!following.length) { await mark(a.handle, 'empty', 0); return { handle: a.handle, status: 'empty' }; }

  const runStart = new Date().toISOString();
  const rows = following.map((f) => ({
    smart_handle: a.handle, target_handle: f.handle, target_user_id: f.id, updated_at: runStart
  }));
  for (const part of chunk(rows, 1000)) {
    await supabase.from('smart_following').upsert(part, { onConflict: 'smart_handle,target_handle' });
  }
  await supabase.from('smart_following').delete().eq('smart_handle', a.handle).lt('updated_at', runStart);
  await mark(a.handle, 'ok', following.length);
  return { handle: a.handle, status: 'ok', count: following.length };
}

async function mark(handle, status, count) {
  await supabase.from('following_refresh').upsert({
    smart_handle: handle, last_refreshed: new Date().toISOString(), following_count: count, status
  });
}

export default async function handler(req, res) {
  const isCron = req.headers['x-vercel-cron'] === '1';
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (!isCron && secret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'unauthorized' });

  try {
    const only = String(req.query.only || '').toLowerCase().replace(/^@/, '').trim();
    const limit = Math.max(1, Math.min(60, parseInt(req.query.limit, 10) || 25));

    const { data: accts, error } = await supabase.from('smart_accounts').select('handle').eq('active', true);
    if (error) throw error;

    let batch;
    if (only) {
      batch = (accts || []).filter((a) => a.handle === only);
    } else {
      // Oldest-first: never-refreshed accounts (priority 0) come before refreshed ones.
      const { data: refreshed } = await supabase.from('following_refresh').select('smart_handle, last_refreshed');
      const seen = {};
      (refreshed || []).forEach((r) => { seen[r.smart_handle] = r.last_refreshed ? Date.parse(r.last_refreshed) : 0; });
      batch = (accts || []).sort((a, b) => (seen[a.handle] || 0) - (seen[b.handle] || 0)).slice(0, limit);
    }

    // Time budget: stop starting new accounts after 40s so we return cleanly
    // before Vercel's 60s function timeout (one big account can take ~18s).
    const started = Date.now();
    const results = [];
    for (const a of batch) {
      if (!only && Date.now() - started > 40000) break;
      try { results.push(await refreshOne(a)); }
      catch (e) { await mark(a.handle, 'error', 0); results.push({ handle: a.handle, status: 'error', error: String((e && e.message) || e) }); }
    }
    return res.status(200).json({ processed: results.length, remaining: batch.length - results.length, results });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
