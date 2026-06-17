// LENS — POST/GET /api/cron/refresh-following
// Pulls each active smart account's following list and upserts edges into Supabase.
// Run on a schedule (see vercel.json) or trigger one account with ?only=<handle>.
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.LENS_SUPABASE_URL,
  process.env.LENS_SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);
const X_BEARER = process.env.X_BEARER_TOKEN;

// ─── PROVIDER ADAPTER ────────────────────────────────────────────────
// Default: official X API v2. To use a third-party (e.g. socialdata.tools),
// replace the two functions below — keep the same return shapes.
async function resolveUserId(handle) {
  const r = await fetch(`https://api.twitter.com/2/users/by/username/${handle}`, {
    headers: { Authorization: `Bearer ${X_BEARER}` }
  });
  const j = await r.json();
  return (j && j.data && j.data.id) || null;
}
// Returns [{ handle, id }] of everyone this user follows.
async function fetchFollowing(userId) {
  const out = [];
  let token = null;
  do {
    const url = new URL(`https://api.twitter.com/2/users/${userId}/following`);
    url.searchParams.set('max_results', '1000');
    if (token) url.searchParams.set('pagination_token', token);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${X_BEARER}` } });
    if (r.status === 429) throw new Error('rate_limited'); // back off; let next run continue
    const j = await r.json();
    (j.data || []).forEach((u) => out.push({ handle: String(u.username).toLowerCase(), id: u.id }));
    token = (j.meta && j.meta.next_token) || null;
  } while (token && out.length < 8000); // safety cap
  return out;
}
// ─────────────────────────────────────────────────────────────────────

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

async function refreshOne(a) {
  let uid = a.user_id;
  if (!uid) {
    uid = await resolveUserId(a.handle);
    if (uid) await supabase.from('smart_accounts').update({ user_id: uid }).eq('handle', a.handle);
  }
  if (!uid) { await mark(a.handle, 'no_id', 0); return { handle: a.handle, status: 'no_id' }; }

  const following = await fetchFollowing(uid);
  if (!following.length) { await mark(a.handle, 'empty', 0); return { handle: a.handle, status: 'empty' }; }

  const runStart = new Date().toISOString();
  const rows = following.map((f) => ({
    smart_handle: a.handle, target_handle: f.handle, target_user_id: f.id, updated_at: runStart
  }));
  for (const part of chunk(rows, 1000)) {
    await supabase.from('smart_following').upsert(part, { onConflict: 'smart_handle,target_handle' });
  }
  // Prune edges this account no longer has (not touched this run).
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
  // Auth: Vercel Cron sets x-vercel-cron; manual triggers need the secret.
  const isCron = req.headers['x-vercel-cron'] === '1';
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (!isCron && secret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'unauthorized' });

  try {
    const only = String(req.query.only || '').toLowerCase().replace(/^@/, '').trim();
    let q = supabase.from('smart_accounts').select('handle, user_id').eq('active', true);
    if (only) q = q.eq('handle', only);
    const { data: accts, error } = await q;
    if (error) throw error;

    const results = [];
    for (const a of accts || []) {
      try { results.push(await refreshOne(a)); }
      catch (e) { await mark(a.handle, 'error', 0); results.push({ handle: a.handle, status: 'error', error: String((e && e.message) || e) }); }
    }
    return res.status(200).json({ refreshed: results.length, results });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
