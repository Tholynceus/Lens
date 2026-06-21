// LENS - per-user Base wallet via Coinbase CDP Server Wallet v2  (ESM)
// Deploy as: Lens repo -> api/wallet.js   (URL: https://lens-liard.vercel.app/api/wallet)
//
// SECURITY MODEL
//  - The private key is generated and held inside Coinbase CDP's TEE enclave.
//    We NEVER store or even see the raw key. We only store the public address.
//  - Every request is authenticated with the caller's Telegram login token
//    (issued by /api/tg-verify and kept in tg_sessions). A user can only ever
//    touch their OWN wallet.
//
// ENV (set in Vercel -> Lens project -> Settings -> Environment Variables):
//    CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET   (from CDP portal)
//    CDP_NETWORK            -> 'base-sepolia' (default, testnet) or 'base' (mainnet)
//    LENS_SUPABASE_URL, LENS_SUPABASE_SERVICE_KEY            (already set)
//
// ROUTES (all GET):
//    /api/wallet?tg_id=..&token=..                 -> get-or-create wallet, returns address + balance
//    /api/wallet?action=balance&tg_id=..&token=..  -> refresh balance only
//    /api/wallet?action=export&tg_id=..&token=..   -> export the raw private key (owner only)

import { CdpClient } from '@coinbase/cdp-sdk';

const SUPABASE_URL = process.env.LENS_SUPABASE_URL || process.env.SUPABASE_URL || 'https://irtfaxhvphjtqczswrck.supabase.co';
const SUPABASE_KEY = process.env.LENS_SUPABASE_SERVICE_KEY
  || process.env.SUPABASE_SERVICE_KEY
  || process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPABASE_KEY;

const NETWORK = (process.env.CDP_NETWORK || 'base-sepolia').toLowerCase();
const RPC = NETWORK === 'base' ? 'https://mainnet.base.org' : 'https://sepolia.base.org';
const NATIVE_ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'; // native ETH sentinel for swaps

function ethToWei(eth) {
  const [i, f = ''] = String(eth || '0').split('.');
  const frac = (f + '0'.repeat(18)).slice(0, 18);
  try { return BigInt(i || '0') * 1000000000000000000n + BigInt(frac || '0'); } catch (e) { return 0n; }
}

const ALLOW = ['https://lnsx.io', 'https://www.lnsx.io'];

function cors(req, res) {
  const origin = req.headers.origin;
  res.setHeader('access-control-allow-origin', ALLOW.includes(origin) ? origin : '*');
  res.setHeader('access-control-allow-methods', 'GET,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
}

// ---- supabase REST helpers ----
async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      authorization: `Bearer ${SUPABASE_KEY}`,
      'content-type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!r.ok && r.status !== 404) throw new Error('supabase ' + r.status);
  const txt = await r.text();
  return txt ? JSON.parse(txt) : null;
}

// verify the caller owns this tg_id (token matches a redeemed login session)
async function authed(tgId, token) {
  if (!tgId || !token) return false;
  const rows = await sb(`tg_sessions?tg_user_id=eq.${encodeURIComponent(tgId)}&token=eq.${encodeURIComponent(token)}&used=eq.true&select=tg_user_id,tg_username&limit=1`);
  return Array.isArray(rows) && rows.length ? rows[0] : false;
}

function walletName(tgId, idx) { return idx > 1 ? `tg-${tgId}-${idx}` : `tg-${tgId}`; }

async function getStoredWallet(tgId, idx) {
  try {
    const rows = await sb(`tg_wallets?tg_user_id=eq.${encodeURIComponent(tgId)}&idx=eq.${idx}&select=*&limit=1`);
    if (Array.isArray(rows) && rows.length) return rows[0];
  } catch (e) {}
  // pre-migration fallback (no idx column yet): primary wallet only
  if (Number(idx) === 1) {
    try {
      const rows = await sb(`tg_wallets?tg_user_id=eq.${encodeURIComponent(tgId)}&select=*&limit=1`);
      return Array.isArray(rows) && rows.length ? rows[0] : null;
    } catch (e) {}
  }
  return null;
}
async function listWallets(tgId) {
  try {
    const rows = await sb(`tg_wallets?tg_user_id=eq.${encodeURIComponent(tgId)}&select=idx,address,network&order=idx.asc`);
    if (Array.isArray(rows)) return rows.map(r => ({ idx: r.idx || 1, address: r.address, network: r.network }));
  } catch (e) {}
  // pre-migration fallback
  try {
    const rows = await sb(`tg_wallets?tg_user_id=eq.${encodeURIComponent(tgId)}&select=address,network&limit=1`);
    return Array.isArray(rows) ? rows.map(r => ({ idx: 1, address: r.address, network: r.network })) : [];
  } catch (e) { return []; }
}

async function ethBalance(address) {
  try {
    const r = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] }),
    });
    const j = await r.json();
    const wei = BigInt(j.result || '0x0');
    return Number(wei) / 1e18;
  } catch (e) { return 0; }
}

function cdp() {
  return new CdpClient({
    apiKeyId: process.env.CDP_API_KEY_ID,
    apiKeySecret: process.env.CDP_API_KEY_SECRET,
    walletSecret: process.env.CDP_WALLET_SECRET,
  });
}

// ---- price + trade ledger (powers REAL PnL) ----
const WETH_BASE = '0x4200000000000000000000000000000000000006';
async function priceUsdOf(addr) {
  try {
    const r = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + addr);
    const j = await r.json();
    let best = 0, liq = -1;
    (j.pairs || []).forEach(p => {
      if (p.chainId !== 'base') return;
      const l = (p.liquidity && p.liquidity.usd) || 0;
      if (l > liq) { liq = l; best = parseFloat(p.priceUsd) || 0; }
    });
    return best;
  } catch (e) { return 0; }
}
async function getEthUsd() {
  const p = await priceUsdOf(WETH_BASE);
  return p > 0 ? p : 3400;
}
async function recordTrade(tgId, walletIdx, tokenAddr, side, ethAmount, tokenAmount, priceUsd, txHash) {
  try {
    await sb('tg_trades', {
      method: 'POST',
      headers: { prefer: 'return=minimal' },
      body: JSON.stringify({
        tg_user_id: Number(tgId),
        wallet_idx: Number(walletIdx) || 1,
        token_address: String(tokenAddr).toLowerCase(),
        side,
        eth_amount: Number(ethAmount) || 0,
        token_amount: Number(tokenAmount) || 0,
        price_usd: Number(priceUsd) || 0,
        tx_hash: txHash || null,
      }),
    });
  } catch (e) {}
}

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const q = req.query || {};
  const tgId = q.tg_id || q.id;
  const token = q.token;
  const action = q.action || 'wallet';

  if (!process.env.CDP_API_KEY_ID || !process.env.CDP_WALLET_SECRET) {
    res.status(500).json({ ok: false, error: 'CDP env not set' }); return;
  }

  const who = await authed(tgId, token);
  if (!who) { res.status(401).json({ ok: false, error: 'not authorized' }); return; }

  const w = Math.max(1, parseInt(q.w || '1', 10) || 1);
  const accountName = walletName(tgId, w);

  try {
    // list all of the user's wallets (kept across switches, old ones never deleted)
    if (action === 'wallets') {
      const list = await listWallets(tgId);
      // make sure the primary wallet exists so a brand-new user always has one
      if (!list.length) {
        const client = cdp();
        const account = await client.evm.getOrCreateAccount({ name: walletName(tgId, 1) });
        await sb('tg_wallets', {
          method: 'POST',
          headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({ tg_user_id: Number(tgId), tg_username: who.tg_username || null, address: account.address, account_name: walletName(tgId, 1), network: NETWORK, idx: 1 }),
        });
        res.status(200).json({ ok: true, wallets: [{ idx: 1, address: account.address, network: NETWORK }] });
        return;
      }
      res.status(200).json({ ok: true, wallets: list });
      return;
    }

    // create an additional wallet (next index); old wallets are kept
    if (action === 'newwallet') {
      const list = await listWallets(tgId);
      const nextIdx = list.reduce((m, r) => Math.max(m, r.idx || 1), 0) + 1;
      const client = cdp();
      const account = await client.evm.getOrCreateAccount({ name: walletName(tgId, nextIdx) });
      await sb('tg_wallets', {
        method: 'POST',
        headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ tg_user_id: Number(tgId), tg_username: who.tg_username || null, address: account.address, account_name: walletName(tgId, nextIdx), network: NETWORK, idx: nextIdx }),
      });
      res.status(200).json({ ok: true, idx: nextIdx, address: account.address, network: NETWORK });
      return;
    }

    // ensure the selected wallet exists (idempotent), then cache the address
    let stored = await getStoredWallet(tgId, w);
    let address = stored && stored.address;

    if (!address) {
      const client = cdp();
      const account = await client.evm.getOrCreateAccount({ name: accountName });
      address = account.address;
      // upsert into tg_wallets
      await sb('tg_wallets', {
        method: 'POST',
        headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
          tg_user_id: Number(tgId),
          tg_username: who.tg_username || null,
          address,
          account_name: accountName,
          network: NETWORK,
          idx: w,
        }),
      });
    }

    if (action === 'export') {
      // owner-only export of the raw private key (their wallet, their right)
      const client = cdp();
      let pk = await client.evm.exportAccount({ name: accountName });
      if (pk && typeof pk === 'object') pk = pk.privateKey || pk.private_key || pk.key || pk.secret || '';
      res.status(200).json({ ok: true, address, network: NETWORK, privateKey: String(pk || '') });
      return;
    }

    if (action === 'buy') {
      // one-tap buy: swap native ETH -> token via CDP Swap API (mainnet only)
      if (NETWORK !== 'base') { res.status(400).json({ ok: false, error: 'buy needs mainnet, set CDP_NETWORK=base' }); return; }
      const to = (q.to || '').trim();
      if (!/^0x[a-fA-F0-9]{40}$/.test(to)) { res.status(400).json({ ok: false, error: 'bad token address' }); return; }
      const wei = ethToWei(q.amount || q.amt);
      if (wei <= 0n) { res.status(400).json({ ok: false, error: 'bad amount' }); return; }
      const slippageBps = Math.min(Math.max(parseInt(q.slip || '200', 10) || 200, 10), 1000); // 0.1%-10%, default 2%

      const client = cdp();
      const account = await client.evm.getOrCreateAccount({ name: accountName });
      const quote = await account.quoteSwap({
        network: 'base',
        fromToken: NATIVE_ETH,
        toToken: to,
        fromAmount: wei,
        slippageBps,
      });
      if (!quote || quote.liquidityAvailable === false) { res.status(400).json({ ok: false, error: 'no liquidity for this size' }); return; }
      const out = await quote.execute();
      // log the trade so PnL is computed from real fills (best-effort)
      try {
        const ethAmt = Number(q.amount || q.amt) || 0;
        const px = await priceUsdOf(to);
        const ethUsd = await getEthUsd();
        const tokAmt = px > 0 ? (ethAmt * ethUsd) / px : 0;
        await recordTrade(tgId, to, 'buy', ethAmt, tokAmt, px, out.transactionHash);
      } catch (e) {}
      res.status(200).json({
        ok: true,
        transactionHash: out.transactionHash,
        toAmount: quote.toAmount != null ? quote.toAmount.toString() : null,
      });
      return;
    }

    if (action === 'tokens') {
      const client = cdp();
      let out = [];
      try {
        const r = await client.evm.listTokenBalances({ address, network: NETWORK });
        out = (r.balances || []).map(b => {
          const dec = (b.amount && b.amount.decimals) || 18;
          const raw = (b.amount && b.amount.amount) || '0';
          return {
            address: b.token.contractAddress,
            symbol: b.token.symbol || null,
            decimals: dec,
            raw: String(raw),
            amount: Number(raw) / Math.pow(10, dec),
          };
        }).filter(t => t.amount > 0 && t.address && t.address.toLowerCase() !== '0x0000000000000000000000000000000000000000');
      } catch (e) {}
      res.status(200).json({ ok: true, tokens: out });
      return;
    }

    if (action === 'sell') {
      // swap token -> native ETH (mainnet only)
      if (NETWORK !== 'base') { res.status(400).json({ ok: false, error: 'sell needs mainnet, set CDP_NETWORK=base' }); return; }
      const from = (q.from || '').trim();
      if (!/^0x[a-fA-F0-9]{40}$/.test(from)) { res.status(400).json({ ok: false, error: 'bad token address' }); return; }
      const slippageBps = Math.min(Math.max(parseInt(q.slip || '200', 10) || 200, 10), 1000);

      const client = cdp();
      const account = await client.evm.getOrCreateAccount({ name: accountName });
      const bals = await client.evm.listTokenBalances({ address, network: 'base' });
      const tb = (bals.balances || []).find(b => b.token.contractAddress.toLowerCase() === from.toLowerCase());
      if (!tb) { res.status(400).json({ ok: false, error: 'you do not hold this token' }); return; }

      let rawAmt = BigInt(tb.amount.amount);
      if (q.raw) { try { rawAmt = BigInt(q.raw); } catch (e) {} }
      else { const pct = Math.min(Math.max(parseInt(q.percent || '100', 10) || 100, 1), 100); rawAmt = rawAmt * BigInt(pct) / 100n; }
      if (rawAmt <= 0n) { res.status(400).json({ ok: false, error: 'nothing to sell' }); return; }

      const quote = await account.quoteSwap({ network: 'base', fromToken: from, toToken: NATIVE_ETH, fromAmount: rawAmt, slippageBps });
      if (!quote || quote.liquidityAvailable === false) { res.status(400).json({ ok: false, error: 'no liquidity for this size' }); return; }
      const out = await quote.execute();
      // log the sell so realized PnL is tracked (best-effort)
      try {
        const dec = (tb.amount && tb.amount.decimals) || 18;
        const tokAmt = Number(rawAmt) / Math.pow(10, dec);
        const px = await priceUsdOf(from);
        const ethUsd = await getEthUsd();
        const ethAmt = (px > 0 && ethUsd > 0) ? (tokAmt * px) / ethUsd : 0;
        await recordTrade(tgId, from, 'sell', ethAmt, tokAmt, px, out.transactionHash);
      } catch (e) {}
      res.status(200).json({ ok: true, transactionHash: out.transactionHash });
      return;
    }

    if (action === 'pnl') {
      // REAL PnL from the trade ledger + current balances + live prices
      const trades = (await sb(`tg_trades?tg_user_id=eq.${encodeURIComponent(tgId)}&select=token_address,side,eth_amount,token_amount,price_usd&order=created_at.asc`)) || [];

      // current on-chain balances
      const balances = {};
      try {
        const client = cdp();
        const r = await client.evm.listTokenBalances({ address, network: NETWORK });
        (r.balances || []).forEach(b => {
          const dec = (b.amount && b.amount.decimals) || 18;
          const raw = (b.amount && b.amount.amount) || '0';
          balances[b.token.contractAddress.toLowerCase()] = Number(raw) / Math.pow(10, dec);
        });
      } catch (e) {}

      // aggregate trades per token
      const byTok = {};
      trades.forEach(t => {
        const a = String(t.token_address).toLowerCase();
        if (!byTok[a]) byTok[a] = { buyTok: 0, buyUsd: 0, sellTok: 0, sellUsd: 0 };
        const g = byTok[a];
        const tok = Number(t.token_amount) || 0;
        const usd = tok * (Number(t.price_usd) || 0);
        if (t.side === 'buy') { g.buyTok += tok; g.buyUsd += usd; }
        else { g.sellTok += tok; g.sellUsd += usd; }
      });

      // live prices for everything held or traded
      const addrs = Array.from(new Set([...Object.keys(byTok), ...Object.keys(balances)]));
      const priceMap = {};
      await Promise.all(addrs.map(async a => { priceMap[a] = await priceUsdOf(a); }));

      let totPnl = 0, totValue = 0, totCost = 0, totReal = 0;
      const positions = addrs.map(a => {
        const g = byTok[a] || { buyTok: 0, buyUsd: 0, sellTok: 0, sellUsd: 0 };
        const held = balances[a] || 0;
        const avgBuy = g.buyTok > 0 ? g.buyUsd / g.buyTok : 0;     // avg cost (usd/token)
        const realized = g.sellUsd - g.sellTok * avgBuy;
        const price = priceMap[a] || 0;
        const value = held * price;
        const costRemain = held * avgBuy;
        const unrealized = value - costRemain;
        const pnl = realized + unrealized;
        totPnl += pnl; totValue += value; totCost += costRemain; totReal += realized;
        return {
          address: a, held, avgBuyUsd: avgBuy, price,
          valueUsd: value, costUsd: costRemain,
          realizedUsd: realized, unrealizedUsd: unrealized, pnlUsd: pnl,
          pnlPct: costRemain > 0 ? (unrealized / costRemain * 100) : null,
        };
      }).filter(p => p.held > 0 || Math.abs(p.realizedUsd) > 1e-6);

      res.status(200).json({
        ok: true,
        positions,
        totals: {
          pnlUsd: totPnl, valueUsd: totValue, costUsd: totCost, realizedUsd: totReal,
          pnlPct: totCost > 0 ? ((totValue - totCost) / totCost * 100) : null,
        },
      });
      return;
    }

    const balance = await ethBalance(address);
    res.status(200).json({ ok: true, address, network: NETWORK, balanceEth: balance });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e && e.message) || String(e) });
  }
}
