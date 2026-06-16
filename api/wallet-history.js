// LENS — /api/wallet-history?username=<handle>
// Raw PostgREST (no SDK), service_role key. Returns wallets mentioned across a
// profile's archived tweets, grouped, with deleted tweets flagged.
//
// Env required: LENS_SUPABASE_URL, LENS_SUPABASE_SERVICE_KEY (service_role secret)

const SUPABASE_URL = process.env.LENS_SUPABASE_URL;
const SERVICE_KEY = process.env.LENS_SUPABASE_SERVICE_KEY;
const REST = `${SUPABASE_URL}/rest/v1`;

function H(prefer) {
  const h = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };
  if (prefer) h.Prefer = prefer;
  return h;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');

  const username = String((req.query && req.query.username) || '').toLowerCase().replace(/^@/, '');
  if (!username) return res.status(200).json({ success: false, mentioned_wallets: [] });

  try {
    // Lazily register the profile so the network starts archiving it.
    await fetch(`${REST}/tracked_profiles?on_conflict=username`, {
      method: 'POST', headers: H('resolution=ignore-duplicates,return=minimal'),
      body: JSON.stringify([{ username, active: true }]),
    });

    const q = `/wallet_mentions?username=eq.${encodeURIComponent(username)}` +
      `&select=wallet,chain,source,tweets(text,created_at,deleted,deleted_at,like_count,retweet_count,reply_count)`;
    const r = await fetch(`${REST}${q}`, { headers: H() });
    if (!r.ok) throw new Error(`GET ${r.status}: ${await r.text()}`);
    const mentions = await r.json();

    const byWallet = new Map();
    for (const m of (mentions || [])) {
      const t = m.tweets || null;
      let w = byWallet.get(m.wallet);
      if (!w) { w = { wallet: m.wallet, chain: m.chain, in_bio: false, tweet_count: 0, deleted_count: 0, tweets: [] }; byWallet.set(m.wallet, w); }
      if (m.source === 'bio' || !t) { w.in_bio = true; continue; }
      w.tweet_count += 1;
      if (t.deleted) w.deleted_count += 1;
      w.tweets.push({
        text: t.text, created_at: t.created_at, deleted: !!t.deleted, deleted_at: t.deleted_at,
        likes: t.like_count, retweets: t.retweet_count, replies: t.reply_count,
      });
    }

    const mentioned_wallets = [...byWallet.values()]
      .map(w => { w.tweets.sort((a, b) => (a.created_at < b.created_at ? 1 : -1)); return w; })
      .sort((a, b) => (b.deleted_count - a.deleted_count) || (b.tweet_count - a.tweet_count) || (b.in_bio - a.in_bio));

    return res.status(200).json({ success: true, username, tracking: mentioned_wallets.length === 0, mentioned_wallets });
  } catch (e) {
    return res.status(200).json({ success: false, mentioned_wallets: [], error: String((e && e.message) || e) });
  }
}
