// LENS — GET /api/smart-followers?handle=<target>
// Returns the curated smart accounts that follow <target>.
// LENS content script calls this on profile load.
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.LENS_SUPABASE_URL,
  process.env.LENS_SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

const ALLOWED = ['https://x.com', 'https://twitter.com'];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });

  const handle = String(req.query.handle || '').toLowerCase().replace(/^@/, '').trim();
  if (!/^[a-z0-9_]{1,15}$/.test(handle)) return res.status(400).json({ error: 'bad handle' });

  try {
    // Join smart_following -> smart_accounts, only active accounts.
    const { data, error } = await supabase
      .from('smart_following')
      .select('smart_accounts!inner(handle, display_name, avatar, label, active)')
      .eq('target_handle', handle)
      .eq('smart_accounts.active', true);
    if (error) throw error;

    const followers = (data || [])
      .map((r) => r.smart_accounts)
      .filter(Boolean)
      .map((s) => ({ handle: s.handle, name: s.display_name, avatar: s.avatar, label: s.label }));

    // CDN-cache 5 min; serve stale up to 10 min while revalidating.
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({ handle, count: followers.length, followers });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
