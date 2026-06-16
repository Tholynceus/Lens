// LENS — /api/wallet-history?username=<handle>
// Returns wallets mentioned across a profile's archived tweets, grouped by wallet,
// each with its mentioning tweets (deleted ones flagged). Lazily starts tracking
// any profile that's requested but not yet archived.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');

  const username = String((req.query && req.query.username) || '').toLowerCase().replace(/^@/, '');
  if (!username) return res.status(200).json({ success: false, mentioned_wallets: [] });

  try {
    // Lazily register the profile so the cron starts archiving it next run.
    await supabase.from('tracked_profiles')
      .upsert({ username, active: true }, { onConflict: 'username', ignoreDuplicates: true });

    const { data: mentions } = await supabase
      .from('wallet_mentions')
      .select('wallet, chain, tweets(text, created_at, deleted, deleted_at, like_count, retweet_count, reply_count)')
      .eq('username', username);

    const byWallet = new Map();
    for (const m of (mentions || [])) {
      const t = m.tweets || {};
      let w = byWallet.get(m.wallet);
      if (!w) { w = { wallet: m.wallet, chain: m.chain, tweet_count: 0, deleted_count: 0, tweets: [] }; byWallet.set(m.wallet, w); }
      w.tweet_count += 1;
      if (t.deleted) w.deleted_count += 1;
      w.tweets.push({
        text: t.text, created_at: t.created_at,
        deleted: !!t.deleted, deleted_at: t.deleted_at,
        likes: t.like_count, retweets: t.retweet_count, replies: t.reply_count,
      });
    }

    const mentioned_wallets = [...byWallet.values()]
      .map(w => { w.tweets.sort((a, b) => (a.created_at < b.created_at ? 1 : -1)); return w; })
      .sort((a, b) => (b.deleted_count - a.deleted_count) || (b.tweet_count - a.tweet_count));

    // "tracking" = true when we have not archived this profile yet (data still warming up)
    const tracking = mentioned_wallets.length === 0;
    return res.status(200).json({ success: true, username, tracking, mentioned_wallets });
  } catch (e) {
    return res.status(200).json({ success: false, mentioned_wallets: [], error: String((e && e.message) || e) });
  }
}
