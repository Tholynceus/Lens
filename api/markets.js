// api/markets.js
// Server-side market board (no browser CORS). Returns ready-to-render Base coins.
// COIN SOURCING IS CLANKER + BANKR ONLY (their native APIs). GeckoTerminal is NOT used to
// decide which coins appear anywhere — it can't attribute a launchpad, so it mislabels coins
// and adds non-clanker/bankr noise. Gecko is used solely to draw OHLCV candles for a coin that
// is already on the board (no native candle API exists on Clanker/Bankr).
//
// Sources (all server-side, each with timeout + UA so one slow source can't hang the fn):
//   Clanker API     -> launches (market-cap / tx-h24 / deployed-at) w/ timestamp + market price
//   Bankr launches  -> bankr-tagged launches w/ timestamp + market price
// then DexScreener for live price/vol/mcap, LENS verdict attached AFTER slicing (caps lookups).
//
// Routes:
//   /api/markets                 -> board, Clanker + Bankr, sorted by 24h volume
//   /api/markets?feed=new        -> freshest CLANKER + BANKR launches, newest first (precise)
//   /api/markets?candles=<pool>&tf=5m|1h|1d -> OHLCV candles (GeckoTerminal, charting only)
//
// feed=new precision notes:
//   - Brand-new coins are NOT dropped for missing a DexScreener pair: price falls back to the
//     launchpad's own market data, so the freshest launches still surface.
//   - Coins carry a real deploy timestamp (ts), are filtered to a recency window, and sorted
//     newest-first, so "new" means recently deployed, not just newly-seen.

const LENS_API = process.env.LENS_API || 'https://lens-liard.vercel.app';
const MAX = parseInt(process.env.MARKETS_MAX || '30', 10);
const NEW_WINDOW_MIN = parseInt(process.env.NEW_WINDOW_MIN || '120', 10); // freshness window for feed=new
const BANKR_LAUNCHES = 'https://api.bankr.bot/token-launches';
const CLANKER = 'https://www.clanker.world/api/tokens';
const GECKO = 'https://api.geckoterminal.com/api/v2/networks/base';
const UA = 'LENS/1.0 (+https://lnsx.io)';

const STABLES = new Set([
  '0x4200000000000000000000000000000000000006', // WETH
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
  '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca', // USDbC
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', // DAI
  '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22', // cbETH
]);

function normVerdict(v){
  v = String(v||'').toLowerCase();
  if (v.includes('stop')) return 'stop';
  if (v.includes('caution') || v.includes('warn') || v.includes('risk')) return 'caution';
  if (v.includes('clear') || v.includes('safe') || v.includes('ok')) return 'clear';
  return 'caution';
}
function srcOf(tok){
  try {
    const blob = JSON.stringify(tok.social_context || tok.socialContext || tok.metadata || '').toLowerCase();
    if (blob.includes('bankr')) return 'bankr';
  } catch(e){}
  return 'clanker';
}

// robust deploy-timestamp parser -> epoch ms, or null if unknown.
// handles ISO strings, unix seconds, and unix ms across a bunch of field names.
function tsOf(o){
  const cand =
    o.created_at ?? o.createdAt ?? o.deployed_at ?? o.deployedAt ??
    o.launchedAt ?? o.launched_at ?? o.launch_time ?? o.launchTime ??
    o.timestamp ?? o.block_timestamp ?? o.blockTimestamp ??
    (o.pool && (o.pool.created_at || o.pool.createdAt)) ??
    (o.token && (o.token.created_at || o.token.createdAt || o.token.deployedAt)) ?? null;
  if (cand == null) return null;
  if (typeof cand === 'number'){
    return cand < 1e12 ? Math.round(cand * 1000) : Math.round(cand); // seconds vs ms
  }
  const n = Date.parse(cand);
  return isNaN(n) ? null : n;
}

// first positive number from a list of candidates, else 0
function num(...vals){
  for (const v of vals){ const n = parseFloat(v); if (isFinite(n) && n > 0) return n; }
  return 0;
}

// Bankr returns images as ipfs:// URIs, which <img> can't load. Route them through a gateway.
function ipfsToHttp(u){
  if (!u || typeof u !== 'string') return u || null;
  if (u.startsWith('ipfs://')) return 'https://ipfs.io/ipfs/' + u.slice(7).replace(/^ipfs\//, '');
  return u;
}

async function fetchJson(url, opts = {}, timeout = 5000){
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: { 'user-agent': UA, accept: 'application/json', ...(opts.headers || {}) },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch(e){ return null; } finally { clearTimeout(id); }
}

// GeckoTerminal is used only for OHLCV candles (see the candles route in the handler).
// It is intentionally NOT used to source which coins appear on the board or the new feed.

async function getClanker(sortBy){
  const j = await fetchJson(`${CLANKER}?chainId=8453&sortBy=${sortBy}&sort=desc&limit=20&includeMarket=true`);
  if (!j) return [];
  const arr = Array.isArray(j) ? j : (j.data || j.tokens || []);
  return arr.map(o => {
    const a = o.contract_address || o.contractAddress || o.address; if (!a) return null;
    // base only: the API already filters via chainId=8453, this is a belt-and-suspenders guard
    if (o.chain_id != null && Number(o.chain_id) !== 8453) return null;
    // clanker market data lives under related.market: { price, marketCap }
    const m = (o.related && o.related.market) || o.market || o.marketData || o.market_data || {};
    return {
      address: String(a).toLowerCase(),
      src: srcOf(o),
      name: o.name || null,
      sym: o.symbol || null,
      img: ipfsToHttp(o.img_url || o.imageUrl || o.imageUri || o.image || null),
      ts: tsOf(o),
      cprice: num(m.price, m.priceUsd, m.price_usd, o.price_usd, o.priceUsd),
      cmcap: num(m.marketCap, m.market_cap, m.fdv, o.market_cap, o.marketCap, o.fdv),
    };
  }).filter(Boolean);
}

async function getBankr(){
  const j = await fetchJson(BANKR_LAUNCHES);
  if (!j) return [];
  const arr = Array.isArray(j) ? j : (j.launches || j.data || j.results || j.tokens || j.tokenLaunches || []);
  const pickAddr = o => o.tokenAddress || o.address || o.token_address || o.contractAddress || o.ca || (o.token && (o.token.address || o.token.tokenAddress)) || null;
  return arr.map(o => {
    const a = pickAddr(o); if (!a) return null;
    // bankr feed is Base-only in practice; skip anything else if a chain is given
    if (o.chain && String(o.chain).toLowerCase() !== 'base') return null;
    const t = o.token || {};
    return {
      address: String(a).toLowerCase(), src: 'bankr',
      name: o.tokenName || o.name || t.name || null,
      sym: o.tokenSymbol || o.symbol || t.symbol || null,
      img: ipfsToHttp(o.imageUri || o.image || o.imageUrl || o.logo || t.image || t.imageUrl || null),
      ts: tsOf(o),
      // bankr launch feed carries no price/mcap; these stay 0 and DexScreener fills them in
      cprice: num(o.price_usd, o.priceUsd),
      cmcap: num(o.market_cap, o.marketCap, o.fdv),
    };
  }).filter(Boolean);
}

async function getDex(addrs){
  const map = {};
  if (!addrs.length) return map;
  for (let i = 0; i < addrs.length; i += 30){
    const chunk = addrs.slice(i, i + 30);
    const j = await fetchJson('https://api.dexscreener.com/latest/dex/tokens/' + chunk.join(','), {}, 6000);
    if (!j) continue;
    (j.pairs || []).forEach(p => {
      if (p.chainId !== 'base') return;
      const a = (p.baseToken.address || '').toLowerCase();
      const liq = (p.liquidity && p.liquidity.usd) || 0;
      if (!map[a] || liq > map[a]._liq){
        map[a] = {
          _liq: liq,
          pool: p.pairAddress || null,
          name: p.baseToken.name, sym: p.baseToken.symbol,
          price: parseFloat(p.priceUsd) || 0,
          mcap: p.marketCap || p.fdv || 0,
          vol24: (p.volume && p.volume.h24) || 0,
          ch24: (p.priceChange && p.priceChange.h24) || 0,
          img: (p.info && p.info.imageUrl) || null,
          url: p.url,
        };
      }
    });
  }
  return map;
}

async function getVerdict(addr){
  const j = await fetchJson(`${LENS_API}/api/lookup?username=${encodeURIComponent(addr)}`, {}, 1800);
  if (!j) return null;
  const v = j.verdict || (j.read && j.read.verdict);
  if (!v) return null;
  return { verdict: normVerdict(v), trust: (j.trust != null ? j.trust : (j.read && j.read.trust)) };
}

function dedupe(list){
  const seen = {}; const out = [];
  list.forEach(x => { if (!x || !x.address || seen[x.address]) return; seen[x.address] = true; out.push(x); });
  return out;
}

// BOARD enrich: prefer live DexScreener data, but fall back to the launchpad's own
// market price (Clanker carries price+mcap) so freshly deployed coins that DexScreener
// has not indexed yet still populate the board. Only skip a coin with no price anywhere.
async function buildCoins(merged){
  if (!merged.length) return [];
  const dex = await getDex(merged.map(x => x.address));
  return merged.map(x => {
    const d = dex[x.address] || null;
    const price = (d && d.price > 0) ? d.price : (x.cprice || 0);
    if (!(price > 0)) return null; // no price on dex or launchpad -> shows once it gets priced
    return {
      address: x.address, src: x.src,
      sym: (d && d.sym) || x.sym || '?',
      name: (d && d.name) || x.name || (d && d.sym) || x.sym || '?',
      price,
      mcap: (d && d.mcap) || x.cmcap || 0,
      vol24: (d && d.vol24) || 0,
      ch24: (d && d.ch24) || 0,
      img: x.img || (d && d.img) || null,
      url: (d && d.url) || null,
      pool: (d && d.pool) || null,
      ts: x.ts || null,
      verdict: 'caution', trust: null,
    };
  }).filter(Boolean);
}

// NEW-FEED enrich: keep ts, fall back to launchpad market price so the freshest coins still
// surface before DexScreener has indexed them. Only skip a coin if NO price exists anywhere.
async function buildCoinsNew(merged){
  if (!merged.length) return [];
  const dex = await getDex(merged.map(x => x.address));
  return merged.map(x => {
    const d = dex[x.address] || null;
    const price = (d && d.price > 0) ? d.price : (x.cprice || 0);
    if (!(price > 0)) return null; // too fresh to price anywhere -> it'll show next poll
    return {
      address: x.address, src: x.src,
      sym: (d && d.sym) || x.sym || '?',
      name: (d && d.name) || x.name || (d && d.sym) || x.sym || '?',
      price,
      mcap: (d && d.mcap) || x.cmcap || 0,
      vol24: (d && d.vol24) || 0,
      ch24: (d && d.ch24) || 0,
      img: x.img || (d && d.img) || null,
      url: (d && d.url) || null,
      pool: (d && d.pool) || null,
      ts: x.ts || null,
      verdict: 'caution', trust: null,
    };
  }).filter(Boolean);
}

// attach verdicts AFTER slicing so we only ever do <= MAX lookups
async function addVerdicts(coins){
  await Promise.all(coins.map(async c => {
    const v = await getVerdict(c.address);
    if (v){ c.verdict = v.verdict; c.trust = v.trust; }
  }));
  return coins;
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=20, stale-while-revalidate=60');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const feed = (req.query && req.query.feed) || '';
  const candlesPool = (req.query && req.query.candles) || '';

  try {
    if (candlesPool){
      const tf = (req.query.tf || '1h');
      let timeframe = 'hour', aggregate = 1;
      if (tf === '5m'){ timeframe = 'minute'; aggregate = 5; }
      else if (tf === '15m'){ timeframe = 'minute'; aggregate = 15; }
      else if (tf === '1h'){ timeframe = 'hour'; aggregate = 1; }
      else if (tf === '4h'){ timeframe = 'hour'; aggregate = 4; }
      else if (tf === '1d'){ timeframe = 'day'; aggregate = 1; }
      const j = await fetchJson(`${GECKO}/pools/${encodeURIComponent(candlesPool)}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=100&currency=usd`, { headers: { accept: 'application/json;version=20230203' } }, 6000);
      const list = (j && j.data && j.data.attributes && j.data.attributes.ohlcv_list) || [];
      const candles = list.slice().reverse().map(a => ({ t: a[0], o: a[1], h: a[2], l: a[3], c: a[4], v: a[5] }));
      return res.status(200).json({ candles });
    }

    if (feed === 'new'){
      // Clanker + Bankr only, from their native "new" endpoints. Bankr listed first so a coin
      // that appears in Bankr's own launch feed keeps the authoritative bankr tag; clanker fills.
      const [fresh, bankr] = await Promise.all([
        getClanker('deployed-at'),
        getBankr(),
      ]);
      const merged = dedupe([ ...bankr, ...fresh ]);
      let coins = await buildCoinsNew(merged);
      // precision: keep only genuinely recent coins. unknown ts is kept (the source endpoints are
      // already recency-ordered) but ranked after timestamped ones.
      const cutoff = Date.now() - NEW_WINDOW_MIN * 60 * 1000;
      coins = coins.filter(c => c.ts == null || c.ts >= cutoff);
      coins.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      coins = coins.slice(0, MAX);
      await addVerdicts(coins);
      return res.status(200).json({ coins });
    }

    // default board -> top volume across CLANKER + BANKR (no Gecko sourcing)
    const [cap, hot, bankr] = await Promise.all([
      getClanker('market-cap'),
      getClanker('tx-h24'),
      getBankr(),
    ]);
    const merged = dedupe([ ...bankr, ...cap, ...hot ]); // bankr first => authoritative bankr tag; clanker fills
    let coins = await buildCoins(merged);
    coins.sort((a, b) => (b.vol24 || 0) - (a.vol24 || 0));
    coins = coins.slice(0, MAX);
    await addVerdicts(coins);
    return res.status(200).json({ coins });
  } catch (e){
    return res.status(500).json({ error: String((e && e.message) || e), coins: [] });
  }
}
