// LENS - one-time Telegram webhook setup (ESM)
// Deploy as: Lens repo -> api/tg-setup.js
// Then just open in a browser:  https://lens-liard.vercel.app/api/tg-setup
// It uses the BOT_TOKEN env (already set in Vercel) so you never type the token in a URL.

const WEBHOOK_URL = 'https://lens-liard.vercel.app/api/tg-bot';

export default async function handler(req, res) {
  res.setHeader('content-type', 'application/json');
  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (!BOT_TOKEN) {
    res.status(500).json({ ok: false, error: 'BOT_TOKEN env is missing in Vercel' });
    return;
  }

  let setWebhook = null, webhookInfo = null, getMe = null;
  try {
    getMe = await (await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`)).json();
    setWebhook = await (await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${encodeURIComponent(WEBHOOK_URL)}`
    )).json();
    webhookInfo = await (await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`)).json();
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e), getMe, setWebhook, webhookInfo });
    return;
  }

  res.status(200).json({
    bot: getMe && getMe.result ? getMe.result.username : getMe,
    setWebhook,
    webhookInfo,
  });
}
