// LENS — /api/agent  (POST or GET ?q=)
// "Ask LENS" landing-page agent. Takes a contract address or an X handle (or a
// freeform question that contains one), gathers public on-chain / profile data,
// and asks the LLM to explain it in plain English, the way the LENS panel does on X.
//
// Reuses the SAME LLM env as /api/verdict (already configured on the server):
//   LLM_API_KEY   — provider key (Venice). Server only.
//   LLM_API_URL   — default 'https://api.venice.ai/api/v1'
//   LLM_MODEL     — default 'llama-3.3-70b'
//   TWITTERAPI_KEY — twitterapi.io key (for handle lookups). Already set.
//
// Data sources: Dexscreener (public), twitterapi.io (handle), our own
// /api/smart-followers (deployed). No private data, public only.

export const config = { maxDuration: 60 };

const LLM_KEY = process.env.LLM_API_KEY;
const LLM_URL = (process.env.LLM_API_URL || 'https://api.venice.ai/api/v1').replace(/\/+$/, '');
const LLM_MODEL = process.env.LLM_MODEL || 'llama-3.3-70b';
const TWITTERAPI_KEY = process.env.TWITTERAPI_KEY;
const SELF = 'https://lens-liard.vercel.app';

// Only let our own surfaces call this (soft guard against random embeds / cost abuse).
const ALLOW = ['https://lnsx.io', 'https://www.lnsx.io', 'https://x.com', 'https://twitter.com', 'http://localhost'];

const PERSONA = [
  'You are LENS, the on-chain intelligence assistant for crypto Twitter and the Base chain.',
  'You live inside a browser extension that reads any X profile and surfaces on-chain signals.',
  'You can do three things: (1) analyze a contract address, (2) analyze an X account or deployer, and (3) chat and answer questions about LENS itself and about on-chain / crypto concepts.',
  'Voice: friendly, sharp, plain English, lightly casual. Keep replies tight and scannable.',
  'Rules: use ONLY the DATA and DOCS provided for facts. Never invent specific numbers, token stats, names, or features. If you do not know, say so.',
  'When you have token or account DATA, give a one-line bold summary, then 3 to 6 short bullets, then a final "Risk read: LOW | MEDIUM | HIGH" line with a short reason.',
  'When the user asks about LENS features or how something works, answer from the LENS DOCS / KNOWLEDGE provided, briefly.',
  'This is information, not financial advice. Never tell people to buy or sell.',
].join(' ');

const LENS_KNOWLEDGE = [
  'LENS is a Chrome extension at lnsx.io that injects on-chain intelligence under any X/Twitter profile, focused on Base and Bankrbot tokens.',
  'Live features: AI Verdict (one-line LLM risk read), Trust Score, Bankrbot Tokens, Dev Claim Fee tracking, Dev Sold detection, PleaseBro (earning fees from tokens deployed by others), CA Hunter (finds contract addresses in a bio), Contracts Deployed and serial-dev detection, CA History, Bundled Wallets clustering, Linked Accounts (other X profiles sharing a wallet), Funding Trail (funder tracing), Origin Check (location / VPN signal), Token Health (dev live percent of supply), Community Tags, Holders-on-X, and Smart Followers (notable on-chain accounts that follow a profile).',
  'Coming soon: GitHub Intel and Username History.',
  'Smart Followers works by keeping a curated set of high-signal accounts, indexing who each of them follows, then surfacing which of them follow the profile you open. It runs on the LENS backend and needs no other extension.',
  'X handle is @lnsx_io. Docs live at lnsx.io/lens-docs.',
].join(' ');

// Live docs, fetched from the site and cached in the warm instance (1h TTL).
let _docsCache = { text: '', ts: 0 };
async function getDocs() {
  if (_docsCache.text && Date.now() - _docsCache.ts < 3600000) return _docsCache.text;
  try {
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch('https://lnsx.io/lens-docs.html', { signal: ctrl.signal });
    clearTimeout(tm);
    if (r.ok) {
      const html = await r.text();
      const txt = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[a-z]+;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      _docsCache = { text: txt.slice(0, 7000), ts: Date.now() };
    }
  } catch (e) { /* fall back to baked knowledge */ }
  return _docsCache.text;
}

function fmtNum(n) {
  n = Number(n);
  if (!isFinite(n)) return null;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

const CA_RE = /0x[a-fA-F0-9]{40}/;
function detect(q) {
  const text = String(q || '').trim();
  const ca = text.match(CA_RE);
  if (ca) return { type: 'ca', value: ca[0], q: text };
  // x.com/handle or @handle or bare handle
  const urlH = text.match(/(?:x\.com|twitter\.com)\/@?([A-Za-z0-9_]{1,15})/i);
  if (urlH) return { type: 'handle', value: urlH[1].toLowerCase(), q: text };
  const atH = text.match(/@([A-Za-z0-9_]{1,15})/);
  if (atH) return { type: 'handle', value: atH[1].toLowerCase(), q: text };
  const bare = text.match(/^([A-Za-z0-9_]{2,15})$/);
  if (bare) return { type: 'handle', value: bare[1].toLowerCase(), q: text };
  return { type: 'freeform', value: null, q: text };
}

async function getJSON(url, opts = {}, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { clearTimeout(t); return null; }
}

// ── CA → token data via Dexscreener + Alchemy metadata ──
async function gatherCA(ca) {
  const [j, meta] = await Promise.all([
    getJSON(`https://api.dexscreener.com/latest/dex/tokens/${ca}`),
    getJSON(`${SELF}/api/alchemy`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'alchemy_getTokenMetadata', params: [ca] }),
    }),
  ]);
  const md = (meta && meta.result) || {};
  const pairs = (j && j.pairs) || [];
  if (!pairs.length) {
    // no market yet, but metadata may still exist
    if (md.name || md.symbol) return { found: true, ca, name: md.name, symbol: md.symbol, noMarket: true };
    return { found: false, ca };
  }
  pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  const p = pairs[0];
  const ageDays = p.pairCreatedAt ? Math.floor((Date.now() - p.pairCreatedAt) / 86400000) : null;
  const socials = (p.info?.socials || []).map(s => s.type).join(', ') || 'none listed';
  const sites = (p.info?.websites || []).length;
  return {
    found: true, ca,
    name: p.baseToken?.name || md.name, symbol: p.baseToken?.symbol || md.symbol,
    chain: p.chainId, dex: p.dexId,
    priceUsd: p.priceUsd,
    fdv: p.fdv != null ? fmtNum(p.fdv) : null,
    liquidity: p.liquidity?.usd != null ? fmtNum(p.liquidity.usd) : null,
    vol24: p.volume?.h24 != null ? fmtNum(p.volume.h24) : null,
    chg24: p.priceChange?.h24,
    ageDays, socials, websites: sites,
    txns24: p.txns?.h24 ? (p.txns.h24.buys || 0) + ' buys / ' + (p.txns.h24.sells || 0) + ' sells' : null,
  };
}

// ── handle → on-chain intel (lookup) + smart followers + bio ──
async function gatherHandle(handle) {
  const out = { handle, found: false };
  const [lk, sf] = await Promise.all([
    getJSON(`${SELF}/api/lookup?username=${encodeURIComponent(handle)}`),
    getJSON(`${SELF}/api/smart-followers?handle=${encodeURIComponent(handle)}`),
  ]);
  if (lk && lk.success && lk.data && lk.data.found) { out.found = true; out.intel = lk.data; }
  if (sf && Array.isArray(sf.followers)) {
    out.smartFollowers = sf.followers.map(f => '@' + (f.handle || f)).slice(0, 20);
    out.smartFollowerCount = sf.count || out.smartFollowers.length;
    if (out.smartFollowerCount) out.found = true;
  }
  // best-effort profile (bio, name, counts) via twitterapi.io
  if (TWITTERAPI_KEY) {
    const info = await getJSON(
      `https://api.twitterapi.io/twitter/user/info?userName=${encodeURIComponent(handle)}`,
      { headers: { 'X-API-Key': TWITTERAPI_KEY } }
    );
    const u = (info && (info.data || info.user || info)) || {};
    const name = u.name || u.displayName;
    const bio = u.description || u.bio;
    if (name || bio) {
      out.found = true;
      out.name = name || null;
      out.bio = bio ? String(bio).slice(0, 280) : null;
      out.followers = u.followers != null ? fmtNum(u.followers) : (u.followersCount != null ? fmtNum(u.followersCount) : null);
      const caInBio = (bio || '').match(CA_RE);
      if (caInBio) out.bioCA = caInBio[0];
    }
  }
  return out;
}

function buildContext(det, data) {
  if (det.type === 'ca') {
    if (!data.found) return `Contract: ${det.value}\nNo trading pairs found on Dexscreener (could be brand new, no liquidity, or not on a tracked DEX).`;
    return [
      `Contract: ${data.ca}`,
      `Token: ${data.name || '?'} (${data.symbol || '?'}) on ${data.chain || '?'} via ${data.dex || '?'}`,
      `Price USD: ${data.priceUsd ?? '?'}`,
      `FDV: ${data.fdv ?? '?'}   Liquidity: ${data.liquidity ?? '?'}`,
      `24h volume: ${data.vol24 ?? '?'}   24h change: ${data.chg24 != null ? data.chg24 + '%' : '?'}`,
      `24h buys/sells: ${data.txns24 ?? '?'}`,
      `Pair age: ${data.ageDays != null ? data.ageDays + ' days' : '?'}`,
      `Socials: ${data.socials}   Websites listed: ${data.websites}`,
    ].join('\n');
  }
  if (det.type === 'handle') {
    const lines = [`X account: @${data.handle}`];
    if (data.name) lines.push(`Name: ${data.name}`);
    if (data.followers) lines.push(`Followers: ${data.followers}`);
    if (data.bio) lines.push(`Bio: ${data.bio}`);
    if (data.bioCA) lines.push(`Contract address in bio: ${data.bioCA}`);
    const i = data.intel;
    if (i) {
      lines.push(`Bankrbot tokens deployed: ${i.token_count || 0}`);
      const syms = (i.tokens || []).map(t => t.token_symbol || t.token_name).filter(Boolean).slice(0, 8);
      if (syms.length) lines.push(`Token symbols: ${syms.join(', ')}`);
      if (i.has_new_token) lines.push('Has a freshly launched token');
      if (i.sells && i.sells.has_sold) {
        const s = (i.sells.items || []).map(x => `${x.token_symbol || '?'} sold ${x.total_sold} over ${x.sell_count} txns (last ${x.last_sell || '?'})`);
        lines.push(`DEV HAS SOLD: ${s.join('; ')}`);
      } else {
        lines.push('No dev sells detected on tracked tokens');
      }
      if (i.claims && i.claims.has_claimed) lines.push(`Fees claimed: ${i.claims.total_eth_claimed} ETH`);
      if (i.has_please_bro) {
        const pb = (i.please_bro_tokens || []).map(t => `${t.token_symbol || t.token_name} (fee share ${t.fee_share ?? '?'})`);
        lines.push(`PleaseBro - earns fees from tokens deployed by OTHERS: ${i.please_bro_count} (${pb.join(', ')})`);
      }
      if (i.unclaimed_usd_total && parseFloat(i.unclaimed_usd_total) > 0) lines.push(`Unclaimed fees: $${i.unclaimed_usd_total}`);
      if (i.holders_on_x_count) lines.push(`Known X accounts holding this dev's tokens: ${i.holders_on_x_count}`);
      if (i.holder_stats && typeof i.holder_stats === 'object') lines.push(`Holder stats: ${JSON.stringify(i.holder_stats).slice(0, 220)}`);
    } else {
      lines.push("No Bankrbot/Base deploy footprint found for this account (not a tracked deployer).");
    }
    if (data.smartFollowerCount != null) lines.push(`Smart followers (notable on-chain accounts that follow them): ${data.smartFollowerCount}`);
    if (data.smartFollowers?.length) lines.push(`Smart follower handles: ${data.smartFollowers.join(', ')}`);
    if (!data.found) lines.push('No public data could be retrieved for this account.');
    return lines.join('\n');
  }
  return `The user asked: "${det.q}". No contract address or X handle was detected in it.`;
}

export default async function handler(req, res) {
  // Public read-only endpoint: allow any origin so it works on lnsx.io, Vercel
  // preview URLs, and the extension. (Rate-limiting can be added later if needed.)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!LLM_KEY) return res.status(200).json({ ok: false, error: 'LLM_API_KEY not configured' });

  try {
    let q = '', history = [];
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
      body = body || {};
      q = body.q || body.query || body.message || '';
      if (Array.isArray(body.history)) history = body.history;
    } else {
      q = req.query.q || req.query.query || '';
    }
    q = String(q).slice(0, 500).trim();
    if (!q) return res.status(200).json({ ok: false, error: 'empty query' });

    const det = detect(q);

    // gather on-chain data when a CA or handle is present in the message
    let data = {};
    if (det.type === 'ca') data = await gatherCA(det.value);
    else if (det.type === 'handle') data = await gatherHandle(det.value);

    // load docs (cached) so LENS can answer product questions accurately
    const docs = await getDocs();

    const systemContent = PERSONA +
      '\n\nLENS KNOWLEDGE:\n' + LENS_KNOWLEDGE +
      (docs ? '\n\nLENS DOCS (reference, may be truncated):\n' + docs : '');

    // sanitize prior turns: last 8, role + string content only
    const hist = history
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-8)
      .map(m => ({ role: m.role, content: String(m.content).slice(0, 1500) }));

    // current turn, with on-chain DATA appended when we looked something up
    let userContent = q;
    if (det.type === 'ca' || det.type === 'handle') {
      userContent = q + '\n\n[LENS DATA for this lookup, use ONLY this for facts]\n' + buildContext(det, data);
    }

    const messages = [{ role: 'system', content: systemContent }, ...hist, { role: 'user', content: userContent }];

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 25000);
    const r = await fetch(`${LLM_URL}/chat/completions`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}` },
      body: JSON.stringify({ model: LLM_MODEL, temperature: 0.4, max_tokens: 700, messages }),
    });
    clearTimeout(t);

    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return res.status(200).json({ ok: false, error: `provider ${r.status}`, detail: txt.slice(0, 160) });
    }
    const j = await r.json();
    const msg = (j && j.choices && j.choices[0] && j.choices[0].message) || {};
    let answer = msg.content || '';
    if (Array.isArray(answer)) answer = answer.map(p => (typeof p === 'string' ? p : (p && p.text) || '')).join(' ');
    if (!answer && msg.reasoning_content) answer = String(msg.reasoning_content);

    return res.status(200).json({ ok: true, type: det.type, data, answer: answer.trim(), model: LLM_MODEL });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
}
