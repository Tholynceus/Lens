// LENS - Telegram sign-in bot webhook  (ESM, matches your other api files)
// Deploy as: Lens repo -> api/tg-bot.js   (URL: https://lens-liard.vercel.app/api/tg-bot)
//
// Required Vercel env vars (Lens project):
//   BOT_TOKEN                  -> from @BotFather
//   SUPABASE_SERVICE_KEY       -> Supabase service_role key (or SUPABASE_SERVICE_ROLE_KEY)
// Optional:
//   SUPABASE_URL               -> defaults to your project below
//   SITE_URL                   -> defaults to https://lnsx.io
//   TG_WEBHOOK_SECRET          -> if set, Telegram must send it back

import { randomBytes } from 'crypto';

const SUPABASE_URL = process.env.LENS_SUPABASE_URL || process.env.SUPABASE_URL || 'https://irtfaxhvphjtqczswrck.supabase.co';
const SUPABASE_KEY = process.env.LENS_SUPABASE_SERVICE_KEY
  || process.env.SUPABASE_SERVICE_KEY
  || process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPABASE_KEY;
const BOT_TOKEN = process.env.BOT_TOKEN;
const SITE_URL = (process.env.SITE_URL || 'https://lnsx.io').replace(/\/+$/, '');
const WEBHOOK_SECRET = process.env.TG_WEBHOOK_SECRET || '';

const randCode = () => randomBytes(16).toString('hex');

async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json().catch(() => ({}));
}

async function saveCode(row) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/tg_sessions`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      authorization: `Bearer ${SUPABASE_KEY}`,
      'content-type': 'application/json',
      prefer: 'return=minimal',
    },
    body: JSON.stringify(row),
  });
  if (!r.ok) console.error('[tg-bot] supabase insert failed', r.status, await r.text().catch(() => ''));
  return r.ok;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(200).send('ok'); return; }

  if (WEBHOOK_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) {
    res.status(401).send('bad secret'); return;
  }

  let update = req.body;
  if (typeof update === 'string') { try { update = JSON.parse(update); } catch (e) { update = {}; } }

  const msg = update && (update.message || update.edited_message);
  const text = msg && typeof msg.text === 'string' ? msg.text.trim() : '';

  if (msg && text.startsWith('/start')) {
    const from = msg.from || {};
    // web-initiated sign-in passes a token:  /start <token>  (t.me/<bot>?start=<token>)
    const param = (text.split(/\s+/)[1] || '').trim();
    const isNonce = /^[a-f0-9]{16,64}$/i.test(param);
    const code = isNonce ? param.toLowerCase() : randCode();
    const expires = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    await saveCode({
      code,
      tg_user_id: from.id || null,
      tg_username: from.username || null,
      tg_first_name: from.first_name || null,
      used: false,
      created_at: new Date().toISOString(),
      expires_at: expires,
    });

    const magic = `${SITE_URL}/markets?tg_code=${code}`;
    const body = isNonce
      ? ('\u2705 *Signing you in to LENS*\n\n' +
         'Head back to the LENS tab \u2014 you are being signed in automatically.\n\n' +
         'If it does not catch, paste this code on the sign-in screen:\n\n' +
         '`' + code + '`\n\n' +
         '\u23F1 Single-use \u00B7 expires in 5 min. Keep it to yourself.')
      : ('\u{1F511} *Sign in to LENS*\n\n' +
         'This links lnsx.io to your Telegram.\n\n' +
         'Tap *Open LENS* below, or paste this code on the sign-in screen:\n\n' +
         '`' + code + '`\n\n' +
         '\u23F1 Single-use \u00B7 expires in 5 min. Keep it to yourself.');

    await tg('sendMessage', {
      chat_id: msg.chat.id,
      text: body,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '\u{1F511} Open LENS', url: isNonce ? `${SITE_URL}/markets` : magic }]] },
    });
  }

  res.status(200).send('ok');
}
