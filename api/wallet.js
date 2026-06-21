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

async function getStoredWallet(tgId) {
  const rows = await sb(`tg_wallets?tg_user_id=eq.${encodeURIComponent(tgId)}&select=*&limit=1`);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
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

  const accountName = 'tg-' + String(tgId);

  try {
    // ensure the CDP account exists (idempotent), then cache the address
    let stored = await getStoredWallet(tgId);
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
        }),
      });
    }

    if (action === 'export') {
      // owner-only export of the raw private key (their wallet, their right)
      const client = cdp();
      const privateKey = await client.evm.exportAccount({ name: accountName });
      res.status(200).json({ ok: true, address, network: NETWORK, privateKey });
      return;
    }

    const balance = await ethBalance(address);
    res.status(200).json({ ok: true, address, network: NETWORK, balanceEth: balance });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e && e.message) || String(e) });
  }
}
