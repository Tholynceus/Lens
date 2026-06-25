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
const SUPABASE_URL = (process.env.LENS_SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_ANON = process.env.LENS_SUPABASE_ANON_KEY;
const SUPABASE_SERVICE = process.env.LENS_SUPABASE_SERVICE_KEY;

// Only let our own surfaces call this (soft guard against random embeds / cost abuse).
const ALLOW = ['https://lnsx.io', 'https://www.lnsx.io', 'https://x.com', 'https://twitter.com', 'http://localhost'];

const PERSONA = [
  'You are LENS, the on-chain intelligence assistant for crypto Twitter and the Base chain.',
  'You live inside a browser extension that reads any X profile and surfaces on-chain signals.',
  'Talk like a friendly, sharp human having a real conversation, similar to a helpful chat assistant. If the user just greets you or makes small talk (hi, hey, gm, how are you), reply warmly and naturally as if you are speaking with them, then gently offer to look up a token or an account.',
  'You can do three things: (1) analyze a contract address or a $ticker (you can resolve a ticker to its token and report its deployer, fee share, and how many times the dev has claimed fees), (2) analyze an X account or deployer, (3) answer questions about LENS itself and about on-chain / crypto topics.',
  'Stay on topic: LENS, on-chain and crypto, plus light friendly chat. If the user brings up sexual, pornographic, vulgar, hateful, illegal, or clearly unrelated content, do NOT engage with it. Briefly and politely decline and steer the conversation back to what LENS can help with.',
  'Use ONLY the DATA and DOCS provided for facts. Never invent specific numbers, token stats, names, or features. If you do not know, say so.',
  'When the DATA includes "Smart follower handles", actually name a few of them in your reply, not just the count. Render each as a markdown link to their X profile, like [@handle](https://x.com/handle), and keep any role label shown in parentheses after a handle (for example "@jessepollak (Founder)"). List up to 6 of the provided handles verbatim and never invent handles that were not given.',
  'When analysing an X account and a Bio is provided, open by briefly saying who they appear to be based on that bio (their role or project, for example "Jesse Pollak, builder of Base"), using only what the bio states and never inventing a title. Then state clearly whether they have launched or hold any token: if the DATA lists tokens they launched or a contract address in their bio, name it; if none is listed, say they have no token on the tracked feed.',
  'If the DATA includes CA history, report it: how many contract addresses are currently in the bio, and how many were REMOVED over time. Call out removed CAs as a warning sign (devs often delete a token CA from their bio after dumping). If none were removed, you can say the bio CA history looks clean.',
  'If the DATA includes past usernames (handle change history), mention that the account previously went by those handles, and treat frequent handle changes as a mild caution signal. If the DATA includes an account location, state where the account says it is based (note it is self-reported and can be spoofed).',
  'When the DATA says "This is a Bankrbot token", you MUST surface its fee facts in your bullets: the dev fee share, the dev fee claim count (or that there are none yet), and any unclaimed fees. Never silently drop these.',
  'When the DATA includes token market stats (price, FDV or market cap, liquidity, 24h volume, 24h change, buys/sells), you MUST include the key ones in your bullets. Never drop the market data, even when there is also Bankrbot fee data to report: show BOTH the market stats and the fee facts.',
  'Only when you actually have token or account DATA, format it as: one bold summary line, then 4 to 8 short bullets. If the DATA includes a VERDICT (CLEAR, CAUTION, or STOP) with red lines, end with that verdict as a bold line (for example **Verdict: CAUTION**) and then list only the red lines marked TRIGGERED, in plain words, using the verdict and red lines exactly as given without inventing or renaming any. If the data has no VERDICT (for example an account lookup), end with a final "Risk read: LOW | MEDIUM | HIGH" line instead. For normal conversation, just reply naturally in a sentence or two, no forced format.',
  'Reply in the same language the user writes in (for example English, Chinese, Russian, Spanish, French, Vietnamese, Thai). Never reply in Indonesian or Malay: if the user writes in Indonesian or Malay, reply in English instead. If the language is unclear or mixed, default to English. Keep replies tight and clear. This is information, not financial advice, and never tell people to buy or sell.',
  'Never use dash punctuation: no em dash, no en dash, and no double hyphen. Use commas, periods, or shorter sentences instead. A single hyphen inside a real compound word like on-chain is fine.',
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

function timeAgo(ts) {
  const t = new Date(ts).getTime();
  if (!t || isNaN(t)) return '';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24); if (d < 30) return d + 'd ago';
  const mo = Math.floor(d / 30); if (mo < 12) return mo + 'mo ago';
  return Math.floor(mo / 12) + 'y ago';
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
  // $ticker / cashtag → resolve to a token via Dexscreener search
  const tick = text.match(/\$([A-Za-z][A-Za-z0-9]{1,14})\b/);
  if (tick) return { type: 'ticker', value: tick[1], q: text };
  // No bare-word handle detection: a lone word like "hi" or "gm" is conversation,
  // not a username. Handles must be written with @ (or an x.com link).
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

async function sb(path) {
  if (!SUPABASE_URL || !SUPABASE_ANON) return null;
  return getJSON(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}` },
  });
}

// Upsert helper (service key) for the small amount of state the agent writes.
async function sbWrite(table, row, onConflict) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE) return;
  try {
    const q = onConflict ? `?on_conflict=${onConflict}` : '';
    await getJSON(`${SUPABASE_URL}/rest/v1/${table}${q}`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE, Authorization: `Bearer ${SUPABASE_SERVICE}`,
        'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify(row),
    });
  } catch {}
}

const CA_RE_G = /0x[a-fA-F0-9]{40}/g;

// CA history: record CAs seen in a profile's bio over time, and flag ones that
// were present before but are gone now (classic post-pump rug / abandon signal).
// Builds organically: each scan compares the current bio to what we've recorded.
async function trackBioCAs(handle, currentCAs) {
  const h = String(handle || '').toLowerCase().replace(/^@/, '');
  if (!h || !SUPABASE_SERVICE) return null;
  const now = new Date().toISOString();
  const cur = [...new Set((currentCAs || []).map(s => String(s).toLowerCase()))].slice(0, 8);
  try {
    // mark every CA currently in the bio as present
    for (const ca of cur) await sbWrite('bio_ca_history', { handle: h, ca, last_seen: now, removed: false }, 'handle,ca');
    // load full recorded history for this handle
    const rows = (await sb(`bio_ca_history?handle=eq.${encodeURIComponent(h)}&select=ca,removed`)) || [];
    const curSet = new Set(cur);
    // any previously-seen CA that is no longer in the bio = removed
    for (const r of rows) {
      if (!curSet.has(r.ca) && !r.removed) await sbWrite('bio_ca_history', { handle: h, ca: r.ca, removed: true }, 'handle,ca');
    }
    const removed = [...new Set(rows.filter(r => !curSet.has(r.ca)).map(r => r.ca))];
    return { current: cur, removed, total_seen: cur.length + removed.length };
  } catch { return null; }
}

// Live on-chain claim detection via the /api/alchemy proxy (matches FARGRAM).
// A fee claim pays the recipient BOTH the token AND WETH in the same tx.
async function liveClaims(recipient, tokenCA) {
  const WETH = '0x4200000000000000000000000000000000000006';
  const r = String(recipient || '').toLowerCase();
  const tok = String(tokenCA || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(r) || !/^0x[0-9a-f]{40}$/.test(tok)) return null;
  const ask = (contract) => getJSON(`${SELF}/api/alchemy`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'alchemy_getAssetTransfers', params: [{
      toAddress: r, contractAddresses: [contract], category: ['erc20'],
      order: 'desc', withMetadata: true, excludeZeroValue: true, maxCount: '0x3e8',
    }] }),
  });
  try {
    const [w, t] = await Promise.all([ask(WETH), ask(tok)]);
    const wt = (w && w.result && w.result.transfers) || [];
    const tt = (t && t.result && t.result.transfers) || [];
    const wethByTx = new Map();
    for (const x of wt) { const h = String(x.hash || '').toLowerCase(); if (h) wethByTx.set(h, (wethByTx.get(h) || 0) + (x.value || 0)); }
    const done = new Set(); let count = 0, weth = 0; const txs = [];
    for (const x of tt) {
      const h = String(x.hash || '').toLowerCase();
      if (!h || done.has(h) || !wethByTx.has(h)) continue;
      done.add(h); count++; weth += wethByTx.get(h);
      txs.push({ hash: h, weth: wethByTx.get(h), ts: x.metadata?.blockTimestamp || null });
    }
    return count > 0 ? { count, weth, txs } : null;
  } catch { return null; }
}

// CA -> Bankrbot launch record: deployer, fee share, claim count, unclaimed
// Bankr Doppler fee config by CA. Works for OLD tokens that aged out of the
// 100-launch index (which is why $GITLAWB/$AEON showed no fee data before).
async function bankrFeesLive(ca) {
  try {
    const j = await getJSON(`https://api.bankr.bot/public/doppler/token-fees/${ca}?days=30`);
    const tok = j && j.tokens && j.tokens[0];
    if (!tok) return null;
    const totals = j.totals || {};
    return {
      // j.address is the resolved fee beneficiary; tok.initializer is the Doppler
      // pool contract, NOT the recipient — using it was the earlier bug.
      recipient: String(j.address || '').toLowerCase() || null,
      share: tok.share || null,
      unclaimed_weth: totals.claimableWeth || tok.claimable?.token0 || null,
      claimed_weth: totals.claimedWeth ?? tok.claimed?.token0 ?? null,
      claim_count: totals.claimCount != null ? totals.claimCount : (tok.claimed?.count ?? null),
      lifetime_weth: j.lifetimeEarnedWeth || null,
    };
  } catch { return null; }
}

async function bankrByCA(ca) {
  const c = ca.toLowerCase();
  const rows = await sb(`bankr_launches?token_address=eq.${c}&select=*`);
  let t = (rows && rows.length) ? rows[0] : null;

  // Aged-out fallback: pull live fee config from Bankr when not in our index.
  let liveFee = null;
  if (!t) {
    liveFee = await bankrFeesLive(c);
    if (!liveFee) return null;       // genuinely not a Bankr fee token
  }

  const dw = (t ? (t.deployer_wallet || '') : '').toLowerCase();
  const fw = (t ? (t.fee_recipient_wallet || '') : (liveFee.recipient || '')).toLowerCase();
  const recipient = fw || dw;

  let claimCount = t && t.fee_claimed_count != null ? Number(t.fee_claimed_count) : null;
  let claimedEth = null;
  let claimTxs = [];
  // Aged-out tokens: seed authoritative claim count + claimed weth from the Bankr API.
  if (liveFee) {
    if (liveFee.claim_count != null) claimCount = Number(liveFee.claim_count);
    if (liveFee.claimed_weth != null) claimedEth = parseFloat(liveFee.claimed_weth);
  }
  // Live on-chain claim truth (also yields tx links); overrides when it finds claims.
  const live = await liveClaims(recipient, c);
  if (live) {
    claimCount = live.count;
    claimedEth = live.weth;
    claimTxs = live.txs || [];
  } else if (t && /^0x[0-9a-f]{40}$/.test(dw)) {
    const ch = await sb(`bankr_claim_history?deployer_wallet=eq.${dw}&select=total_eth_claimed,claim_count`);
    if (ch && ch.length) {
      claimedEth = ch.reduce((s, r) => s + parseFloat(r.total_eth_claimed || 0), 0);
      const cc = ch.reduce((s, r) => s + parseInt(r.claim_count || 0, 10), 0);
      if (cc) claimCount = cc;
    }
  }

  return {
    isBankr: true,
    deployer_x: t ? (t.x_username || null) : null,
    fee_share: t ? (t.fee_share ?? null) : (liveFee.share ?? null),
    unclaimed_usd: t ? (t.unclaimed_usd ?? null) : null,
    unclaimed_weth: t ? (t.fee_claimable_weth ?? t.unclaimed_weth ?? null) : (liveFee.unclaimed_weth ?? null),
    beneficiary: recipient || null,
    has_claimed: (t ? !!t.fee_has_claimed : false) || (claimCount != null && claimCount > 0),
    claim_count: claimCount,
    claimed_eth: claimedEth != null ? claimedEth.toFixed(4) : null,
    claim_txs: claimTxs,
    is_pleasebro: !!(dw && fw && dw !== fw),
    aged_out: !t,
  };
}

// Handle -> recent Bankrbot launches by this deployer. /api/lookup can lag for
// tokens launched seconds ago; this reads the SAME bankr_launches table the Live
// Feed uses, so the agent stays consistent with what the Live Feed shows.
async function bankrByHandle(handle) {
  const h = String(handle || '').toLowerCase().replace(/^@/, '').trim();
  if (!h) return [];
  const rows = await sb(`bankr_launches?x_username=ilike.${encodeURIComponent(h)}&select=*&limit=20`);
  if (!rows || !rows.length) return [];
  const list = rows
    .filter(t => String(t.x_username || '').toLowerCase() === h) // ilike treats _ as a wildcard; require exact handle
    .map(t => ({
    ca: String(t.token_address || '').toLowerCase(),
    symbol: t.token_symbol || t.symbol || null,
    name: t.token_name || t.name || null,
    launched_at: t.launched_at || t.created_at || null,
  })).filter(t => /^0x[0-9a-f]{40}$/.test(t.ca));
  list.sort((a, b) => new Date(b.launched_at || 0) - new Date(a.launched_at || 0));
  return list;
}

function bankrLines(b) {
  const L = ['This is a Bankrbot token.'];
  if (b.deployer_x) L.push('Deployer X: @' + b.deployer_x);
  if (b.fee_share != null) L.push('Dev fee share: ' + b.fee_share);
  if (b.claim_count != null && b.claim_count > 0) L.push('Dev fee claims: ' + b.claim_count + ' time(s)' + (b.claimed_eth ? ', ' + b.claimed_eth + ' ETH total' : ''));
  else if (b.has_claimed) L.push('Dev has claimed fees at least once');
  else L.push('No dev fee claims yet');
  if (b.unclaimed_usd && parseFloat(b.unclaimed_usd) > 0) L.push('Unclaimed fees: $' + b.unclaimed_usd);
  else if (b.unclaimed_weth && parseFloat(b.unclaimed_weth) > 0) L.push('Unclaimed fees: ' + b.unclaimed_weth + ' weth');
  if (b.is_pleasebro) L.push('Fee recipient differs from deployer (PleaseBro pattern)');
  return L.join('. ');
}

// remove em dash / en dash / double hyphen from the model output, keep single hyphens
function stripDashes(s) {
  if (!s) return s;
  return String(s)
    .replace(/\s*[—–]\s*/g, ', ')   // em / en dash -> comma
    .replace(/ ?-{2,} ?/g, ', ')    // double+ hyphen -> comma
    .replace(/ ,/g, ',')
    .replace(/,\s*,/g, ',')
    .replace(/,\s*([.!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// ── rule-based red-line evaluation for a token (ATBASH-style gate) ──
function tokenRedLines(d) {
  const lines = [];
  const add = (code, label, triggered) => lines.push({ code, label, triggered: !!triggered });

  if (d.liqRaw != null) add('LIQUIDITY', 'Liquidity below $20k, hard to exit', d.liqRaw < 20000);
  if (d.ageDays != null) add('AGE', 'Pair younger than 1 day, unproven', d.ageDays < 1);
  if (d.buys != null && d.sells != null) add('SELL_PRESSURE', 'Sells more than double the buys, distribution', d.sells > d.buys * 2 && d.sells >= 10);
  add('PRESENCE', 'No socials and no website listed', (d.socialsCount || 0) === 0 && (d.websites || 0) === 0);
  if (d.liqRaw != null && d.fdvRaw) add('FLOAT', 'Liquidity under 4% of FDV, thin float vs valuation', d.liqRaw < d.fdvRaw * 0.04);
  if (d.bankr) {
    if (d.bankr.is_pleasebro) add('PLEASEBRO', 'Fee recipient differs from deployer, PleaseBro pattern', true);
    if (d.bankr.claim_count != null) add('DEV_CLAIMS', 'Dev has claimed fees 5 or more times', d.bankr.claim_count >= 5);
  }

  const triggered = lines.filter(l => l.triggered).length;
  let verdict;
  if (triggered === 0) verdict = 'CLEAR';
  else if (triggered <= 2) verdict = 'CAUTION';
  else verdict = 'STOP';
  return { verdict, triggered, total: lines.length, lines };
}

// ── CA → token data via Dexscreener + Alchemy metadata ──
async function gatherCA(ca) {
  const [j, meta, bankr] = await Promise.all([
    getJSON(`https://api.dexscreener.com/latest/dex/tokens/${ca}`),
    getJSON(`${SELF}/api/alchemy`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'alchemy_getTokenMetadata', params: [ca] }),
    }),
    bankrByCA(ca),
  ]);
  const md = (meta && meta.result) || {};
  const basescan = `https://basescan.org/token/${ca}`;
  const pairs = (j && j.pairs) || [];
  if (!pairs.length) {
    if (md.name || md.symbol || bankr) return { found: true, ca, name: md.name, symbol: md.symbol, noMarket: true, bankr, basescan };
    return { found: false, ca, bankr, basescan };
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
    liqRaw: p.liquidity?.usd ?? null, fdvRaw: p.fdv ?? null, vol24Raw: p.volume?.h24 ?? null,
    buys: p.txns?.h24?.buys ?? null, sells: p.txns?.h24?.sells ?? null,
    socialsCount: (p.info?.socials || []).length,
    dexUrl: p.url || null, basescan, bankr,
  };
}

// $ticker -> resolve to a token via Dexscreener search, then full CA analysis
async function gatherTicker(sym) {
  const j = await getJSON(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(sym)}`);
  let pairs = (j && j.pairs) || [];
  const symU = sym.toUpperCase();
  pairs = pairs.filter(p => p.baseToken && (p.baseToken.symbol || '').toUpperCase() === symU);
  if (!pairs.length) return { found: false, ticker: sym };
  // prefer Base, then deepest liquidity
  pairs.sort((a, b) => ((b.chainId === 'base' ? 1 : 0) - (a.chainId === 'base' ? 1 : 0)) || ((b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)));
  const ca = pairs[0].baseToken.address;
  const d = await gatherCA(ca);
  d.resolvedFromTicker = sym;
  d.matchCount = pairs.length;
  return d;
}

// ── handle → on-chain intel (lookup) + smart followers + bio ──
async function gatherHandle(handle) {
  const out = { handle, found: false };
  const [lk, sf, launches, uh] = await Promise.all([
    getJSON(`${SELF}/api/lookup?username=${encodeURIComponent(handle)}`),
    getJSON(`${SELF}/api/smart-followers?handle=${encodeURIComponent(handle)}`),
    bankrByHandle(handle),
    getJSON(`${SELF}/api/lookup?username_history=${encodeURIComponent(handle)}`),
  ]);
  if (lk && lk.success && lk.data && lk.data.found) { out.found = true; out.intel = lk.data; }
  if (Array.isArray(launches) && launches.length) { out.launches = launches; out.found = true; }
  if (sf && Array.isArray(sf.followers)) {
    out.smartFollowers = sf.followers.map(f => {
      const h = '@' + (f.handle || f);
      return f && f.label ? `${h} (${f.label})` : h;
    }).slice(0, 20);
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
    const loc = u.location || u.locationName || (u.profile && u.profile.location);
    if (loc) out.location = String(loc).slice(0, 80);
    if (name || bio) {
      out.found = true;
      out.name = name || null;
      out.bio = bio ? String(bio).slice(0, 280) : null;
      out.followers = u.followers != null ? fmtNum(u.followers) : (u.followersCount != null ? fmtNum(u.followersCount) : null);
      const bioCAs = bio ? [...new Set((String(bio).match(CA_RE_G) || []).map(s => s.toLowerCase()))] : [];
      if (bioCAs.length) out.bioCA = bioCAs[0];
      out.caHistory = await trackBioCAs(handle, bioCAs);
    }
  }
  // username history (memory.lol) — past handles this account used
  if (uh && uh.changed && Array.isArray(uh.previous) && uh.previous.length) {
    out.nameHistory = uh.previous.map(p => p.name).filter(Boolean).slice(0, 6);
    out.found = true;
  }
  return out;
}

function buildContext(det, data) {
  if (det.type === 'ca' || det.type === 'ticker') {
    if (!data.found) {
      if (det.type === 'ticker') return `No token with ticker $${det.value} was found on Dexscreener. Politely ask the user to paste the contract address.`;
      return `Contract: ${det.value}\nNo trading pairs found on Dexscreener (could be brand new, no liquidity, or not on a tracked DEX).` + (data.bankr ? '\n' + bankrLines(data.bankr) : '');
    }
    const lines = [];
    if (data.resolvedFromTicker) lines.push(`Resolved ticker $${data.resolvedFromTicker} to this token${data.matchCount > 1 ? ` (best match by liquidity; ${data.matchCount} tokens share this ticker)` : ''}.`);
    lines.push(`Contract: ${data.ca}`);
    lines.push(`Token: ${data.name || '?'} (${data.symbol || '?'}) on ${data.chain || '?'} via ${data.dex || '?'}`);
    if (!data.noMarket) {
      lines.push(`Price USD: ${data.priceUsd ?? '?'}`);
      lines.push(`FDV: ${data.fdv ?? '?'}   Liquidity: ${data.liquidity ?? '?'}`);
      lines.push(`24h volume: ${data.vol24 ?? '?'}   24h change: ${data.chg24 != null ? data.chg24 + '%' : '?'}`);
      lines.push(`24h buys/sells: ${data.txns24 ?? '?'}`);
      lines.push(`Pair age: ${data.ageDays != null ? data.ageDays + ' days' : '?'}`);
      lines.push(`Socials: ${data.socials}   Websites listed: ${data.websites}`);
    } else {
      lines.push('Token exists on-chain but no active trading pair / market data found yet.');
    }
    if (data.bankr) lines.push(bankrLines(data.bankr));
    if (!data.noMarket) {
      const rl = tokenRedLines(data);
      lines.push(`VERDICT: ${rl.verdict} (${rl.triggered} of ${rl.total} red lines triggered)`);
      rl.lines.forEach(l => lines.push(`  [${l.triggered ? 'TRIGGERED' : 'passed'}] ${l.label}`));
    }
    const src = [];
    if (data.dexUrl) src.push('Dexscreener ' + data.dexUrl);
    if (data.basescan) src.push('BaseScan ' + data.basescan);
    if (src.length) lines.push('Sources: ' + src.join(' | '));
    return lines.join('\n');
  }
  if (det.type === 'handle') {
    const lines = [`X account: @${data.handle}`];
    if (data.name) lines.push(`Name: ${data.name}`);
    if (data.followers) lines.push(`Followers: ${data.followers}`);
    if (data.location) lines.push(`Account location (self-reported on X profile): ${data.location}`);
    if (data.nameHistory && data.nameHistory.length) lines.push(`Past usernames this account previously used (handle change history): ${data.nameHistory.map(n => '@' + n).join(', ')}`);
    if (data.bio) lines.push(`Bio: ${data.bio}`);
    if (data.bioCA) lines.push(`Contract address in bio: ${data.bioCA}`);
    if (data.caHistory) {
      const ch = data.caHistory;
      if (ch.current && ch.current.length) lines.push(`CAs currently in bio (${ch.current.length}): ${ch.current.join(', ')}`);
      if (ch.removed && ch.removed.length) lines.push(`CAs REMOVED from bio over time (${ch.removed.length}), a classic post-pump rug / abandon signal: ${ch.removed.join(', ')}`);
    }
    if (data.launches && data.launches.length) {
      const recent = data.launches.slice(0, 5).map(t => {
        const sym = t.symbol ? `$${t.symbol}` : (t.name || 'token');
        const when = t.launched_at ? ` (${timeAgo(t.launched_at)})` : '';
        return `${sym} ${t.ca}${when}`;
      });
      lines.push(`Tokens launched by this account, from the live Bankrbot launch feed: ${recent.join('; ')}`);
    }
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
    } else if (!(data.launches && data.launches.length)) {
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
    else if (det.type === 'ticker') data = await gatherTicker(det.value);

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
    if (det.type === 'ca' || det.type === 'handle' || det.type === 'ticker') {
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

    answer = stripDashes(answer.trim());

    // Deterministic claim-tx links: tx hashes are 66 chars, so never let the LLM
    // rewrite them. Append correct Basescan links from the data we already fetched.
    const claimTxs = (data && data.bankr && data.bankr.claim_txs)
      || (data && data.claims && data.claims.claim_txs) || [];
    if (claimTxs.length) {
      const links = claimTxs.slice(0, 6).map((x) => {
        const amt = x.weth ? `${Number(x.weth).toFixed(4)} weth ` : '';
        return `${amt}[tx](https://basescan.org/tx/${x.hash})`;
      }).join(', ');
      answer += `\n\n**Claim txs:** ${links}`;
    }

    // Deterministic chart/explorer links for token lookups (always shown, clickable).
    if (det.type === 'ca' || det.type === 'ticker') {
      const L = [];
      if (data && data.dexUrl) L.push(`[Chart](${data.dexUrl})`);
      if (data && data.basescan) L.push(`[BaseScan](${data.basescan})`);
      if (L.length) answer += `\n\n**Links:** ${L.join(' · ')}`;
    }

    return res.status(200).json({ ok: true, type: det.type, data, answer, model: LLM_MODEL });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
}
