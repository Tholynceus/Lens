// LENS - verify a Telegram sign-in code  (ESM)
// Deploy as: Lens repo -> api/tg-verify.js  (URL: https://lens-liard.vercel.app/api/tg-verify)
// Called by markets.html:  GET /api/tg-verify?code=XXXX

import { randomBytes } from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://irtfaxhvphjtqczswrck.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
  || process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPABASE_KEY;

const newToken = () => randomBytes(24).toString('hex');

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const code = (req.query && (req.query.code || req.query.c)) || '';
  if (!code) { res.status(400).json({ ok: false, error: 'missing code' }); return; }

  const q = await fetch(
    `${SUPABASE_URL}/rest/v1/tg_sessions?code=eq.${encodeURIComponent(code)}&select=*`,
    { headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const rows = await q.json().catch(() => []);
  const row = Array.isArray(rows) ? rows[0] : null;

  if (!row) { res.status(404).json({ ok: false, error: 'invalid code' }); return; }
  if (row.used) { res.status(409).json({ ok: false, error: 'code already used' }); return; }
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    res.status(410).json({ ok: false, error: 'code expired' }); return;
  }

  const token = newToken();
  await fetch(`${SUPABASE_URL}/rest/v1/tg_sessions?code=eq.${encodeURIComponent(code)}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY,
      authorization: `Bearer ${SUPABASE_KEY}`,
      'content-type': 'application/json',
      prefer: 'return=minimal',
    },
    body: JSON.stringify({ used: true, token }),
  });

  res.status(200).json({
    ok: true,
    token,
    telegram: {
      id: row.tg_user_id,
      username: row.tg_username,
      first_name: row.tg_first_name,
    },
  });
}
