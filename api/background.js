// LENS Extension v2.2.0 — CA → deployer wallet → Bankrbot auto-detect

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const handlers = {
    FETCH_GITHUB: () => fetchGitHub(request.username),
    FETCH_LENS_PROFILE: () => fetchLensProfile(request.username),
    FETCH_BANKR_FULL: () => fetchBankrFull(request.tokenAddress, request.settings),
    FETCH_USERNAME_HISTORY: () => fetchUsernameHistory(request.username),
    FETCH_LAUNCH_BY_USERNAME: () => fetchLaunchByUsername(request.username),
    FETCH_CABAL: () => fetchCabal(request.tokenAddress, request.deployerWallet),
    FETCH_TOKEN_HEALTH: () => fetchTokenHealth(request.tokenAddress, request.deployerWallet),
    FETCH_DEV_FUNDING: () => fetchDevFunding(request.deployerWallet),
  };
  const handler = handlers[request.type];
  if (handler) {
    handler()
      .then(data => sendResponse({ success: true, data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

// Doppler/Uniswap fee pairs come back as token0/token1 ordered by contract address,
// so token0 is NOT always WETH. Pick the WETH side from the *Label fields instead.
// A creator-fee pair is always PROJECT_TOKEN / WETH, so we can resolve by elimination too.
function pickFeePair(obj) {
  if (!obj) return { weth: null, token: null };
  const isWeth = s => { const u = String(s || '').toUpperCase(); return u === 'ETH' || u.includes('WETH'); };
  const l0 = obj.token0Label, l1 = obj.token1Label;
  if (isWeth(l0)) return { weth: obj.token0 ?? null, token: obj.token1 ?? null };
  if (isWeth(l1)) return { weth: obj.token1 ?? null, token: obj.token0 ?? null };
  // Only the non-WETH side is labeled -> the other side is WETH by elimination.
  if (l1 != null && !isWeth(l1)) return { weth: obj.token0 ?? null, token: obj.token1 ?? null };
  if (l0 != null && !isWeth(l0)) return { weth: obj.token1 ?? null, token: obj.token0 ?? null };
  // No labels at all -> can't tell which side is WETH, so don't guess (avoids the wrong-side bug).
  return { weth: null, token: obj.token0 ?? obj.token1 ?? null };
}

async function getConfig() {
  return new Promise(resolve => {
    chrome.storage.local.get(['GITHUB_TOKEN', 'ALCHEMY_KEY', 'LENS_API_URL'], result => {
      resolve({
        GITHUB_TOKEN: result.GITHUB_TOKEN || '',
        // ALCHEMY_KEY no longer defaults to a bundled key — on-chain calls now
        // route through the backend proxy. A user-supplied key (if present) can
        // still be used as a direct fallback.
        ALCHEMY_KEY: result.ALCHEMY_KEY || '',
        LENS_API_URL: result.LENS_API_URL || 'https://lnsx.io',
      });
    });
  });
}

// ── Alchemy JSON-RPC helper (Base mainnet) ──
// Routes through the LENS backend proxy by default (keeps the key server-side).
// Falls back to a direct call only if the user supplied their own key.
async function alchemyRpc(apiKeyOrUnused, method, params) {
  const { LENS_API_URL, ALCHEMY_KEY } = await getConfig();

  // Preferred path: backend proxy (no key exposed in the extension)
  if (LENS_API_URL) {
    try {
      const res = await fetch(`${LENS_API_URL}/api/alchemy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, params }),
      });
      const json = await res.json();
      if (json && !json.error && 'result' in json) return json.result;
      if (json && json.error) throw new Error(json.error.message || 'Alchemy RPC error');
    } catch (e) {
      // fall through to direct key if available
      if (!ALCHEMY_KEY) throw e;
    }
  }

  // Fallback: direct call with a user-supplied key
  if (!ALCHEMY_KEY) throw new Error('No Alchemy access (proxy failed, no user key)');
  const res = await fetch(`https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || 'Alchemy RPC error');
  return json.result;
}

// ── Resolve contract deployer via Alchemy (fast: getAssetTransfers to find creation tx) ──
async function resolveDeployer(apiKey, tokenAddress) {
  if (!tokenAddress) return null;
  const ca = tokenAddress.toLowerCase();
  const cacheKey = `DEPLOYER_${ca}`;

  // 1. Cache hit
  const cached = await new Promise(r => chrome.storage.local.get([cacheKey], x => r(x[cacheKey])));
  if (cached) return cached === 'NONE' ? null : cached;

  try {
    // 2. Get earliest incoming transfers to the CA — first one is the deploy tx
    const result = await alchemyRpc(apiKey, 'alchemy_getAssetTransfers', [{
      toAddress: ca,
      category: ['external', 'internal'],
      order: 'asc',
      withMetadata: false,
      excludeZeroValue: false,
      maxCount: '0x1',
    }]);
    const transfers = result?.transfers || [];
    if (transfers.length > 0) {
      // Get the full tx to find `from`
      const txHash = transfers[0].hash;
      const tx = await alchemyRpc(apiKey, 'eth_getTransactionByHash', [txHash]);
      if (tx?.from) {
        const deployer = tx.from.toLowerCase();
        // Verify it's an EOA (wallet), not a factory/router contract.
        // Doppler/Bankr tokens are often deployed by a factory contract — that's
        // not the real user wallet, so we must not use it for PleaseBro comparison.
        try {
          const code = await alchemyRpc(apiKey, 'eth_getCode', [deployer, 'latest']);
          if (code && code !== '0x' && code.length > 2) {
            // it's a contract — not a usable deployer wallet
            chrome.storage.local.set({ [cacheKey]: 'NONE' });
            return null;
          }
        } catch (e) {}
        chrome.storage.local.set({ [cacheKey]: deployer });
        return deployer;
      }
    }

    // 3. Fallback: check if address itself has any outgoing transfers (is a wallet not CA)
    chrome.storage.local.set({ [cacheKey]: 'NONE' });
    return null;
  } catch (e) {
    return null;
  }
}

// Fetch wallet stats (username + deploy count) from backend
async function fetchStats(apiUrl, wallet) {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 3500);
    const r = await fetch(`${apiUrl}/api/lookup?stats=${wallet}`, { signal: ctrl.signal });
    clearTimeout(to);
    if (!r.ok) return null;
    const j = await r.json();
    return j.success ? j : null;
  } catch (e) { return null; }
}

// ── MAIN: Full pipeline CA → deployer → Bankrbot ──
async function fetchBankrFull(tokenAddress, settings = {}) {
  if (!tokenAddress) throw new Error('No token address');
  const { ALCHEMY_KEY } = await getConfig();
  // Platform source toggles (default enabled when not provided).
  const srcAlchemy = settings.src_alchemy !== false;
  const srcBankr = settings.src_bankr !== false;

  // Step 1: Resolve deployer wallet via Alchemy binary-search (free tier, no Etherscan)
  let deployerWallet = srcAlchemy ? await resolveDeployer(ALCHEMY_KEY, tokenAddress) : null;
  let tokenName = null;
  let tokenSymbol = null;

  // Step 2: Check if in recent Bankrbot launches (get name/symbol)
  let isBankrToken = false;
  let unclaimedFees = null;
  let feeRecipient = null;
  let deployerXUsername = null;
  let bankrDeployerWallet = null;

  try {
    const listRes = srcBankr ? await fetch('https://api.bankr.bot/token-launches?limit=100') : null;
    if (listRes && listRes.ok) {
      const listData = await listRes.json();
      const launches = Array.isArray(listData) ? listData : (listData.launches || []);
      const found = launches.find(t =>
        (t.tokenAddress || t.address || '').toLowerCase() === tokenAddress.toLowerCase()
      );
      if (found) {
        isBankrToken = true;
        tokenName = found.tokenName || found.name;
        tokenSymbol = found.tokenSymbol || found.symbol;
        deployerXUsername = found.deployer?.xUsername;
        bankrDeployerWallet = (found.deployer?.walletAddress || '').toLowerCase() || null;
        feeRecipient = { wallet: found.feeRecipient?.walletAddress, x_username: found.feeRecipient?.xUsername };
        const uf = found.unclaimedFees;
        if (uf) unclaimedFees = { token_amount: parseFloat(uf.tokenAmount||0), token_symbol: uf.tokenSymbol, weth_amount: parseFloat(uf.wethAmount||0), usd_value: parseFloat(uf.usdValue||0) };
      }
    }
  } catch (e) {}

  // Step 2b: token-fees endpoint — works for OLD tokens not in recent 100.
  // Returns the default fee recipient wallet + share % + claimable + lifetime earned.
  let feeStructure = null;
  try {
    const fr = srcBankr ? await fetch(`https://api.bankr.bot/public/doppler/token-fees/${tokenAddress}`) : null;
    if (fr && fr.ok) {
      const fd = await fr.json();
      const tok = (fd.tokens || [])[0];
      if (tok) {
        const claimPair = pickFeePair(tok.claimable);
        feeStructure = {
          fee_recipient_wallet: fd.address || null,
          share: tok.share || null,
          claimable_weth: claimPair.weth,
          claimable_token: claimPair.token,
          token_symbol: tok.symbol || null,
          lifetime_weth: fd.lifetimeEarnedWeth || null,
          initializer: tok.initializer || null,
        };
        if (!tokenName && tok.name) tokenName = tok.name;
        if (!tokenSymbol && tok.symbol) tokenSymbol = tok.symbol;
        // if launches didn't give a fee recipient, use this one
        if (!feeRecipient && fd.address) {
          feeRecipient = { wallet: fd.address, x_username: null };
        }
        // Resolve fee recipient wallet -> X username
        // Resolve stats (username + deploy count) for fee recipient AND deployer
        let frXUsername = feeRecipient?.x_username || null;
        let frStats = null, depStats = null;
        try {
          const { LENS_API_URL } = await getConfig();
          if (LENS_API_URL) {
            const frw = feeStructure.fee_recipient_wallet;
            const depw = bankrDeployerWallet;
            const calls = [];
            if (frw) calls.push(fetchStats(LENS_API_URL, frw).then(s => { frStats = s; }));
            if (depw) calls.push(fetchStats(LENS_API_URL, depw).then(s => { depStats = s; }));
            await Promise.all(calls);
            if (!frXUsername && frStats?.x_username) frXUsername = frStats.x_username;
          }
        } catch (e) {}
        feeStructure.fee_recipient_x = frXUsername;
        feeStructure.fee_recipient_stats = frStats;
        feeStructure.deployer_stats = depStats;
      }
    }
  } catch (e) {}

  // Step 3: Get token info via Alchemy (name, symbol, supply)
  let tokenSupply = null;
  try {
    const meta = await alchemyRpc(ALCHEMY_KEY, 'alchemy_getTokenMetadata', [tokenAddress]);
    if (meta) {
      if (!tokenName) tokenName = meta.name;
      if (!tokenSymbol) tokenSymbol = meta.symbol;
      // Compute human-readable supply
      if (meta.totalSupply && meta.decimals != null) {
        const raw = BigInt(meta.totalSupply);
        const dec = parseInt(meta.decimals);
        const supply = Number(raw) / Math.pow(10, dec);
        const fmt = n => n >= 1e9 ? `${(n/1e9).toFixed(1)}B` : n >= 1e6 ? `${(n/1e6).toFixed(1)}M` : n >= 1e3 ? `${(n/1e3).toFixed(1)}K` : n.toFixed(0);
        tokenSupply = fmt(supply);
      }
    }
  } catch (e) {}

  // ── Use the REAL dev wallet for activity attribution ──
  // Bankr/Doppler tokens are deployed on-chain by Bankr's SHARED launcher wallet, so the
  // contract deployer is NOT the project owner. The real dev is the fee recipient. Without
  // this, the launcher's aggregate claims/sells across every token it ever launched get
  // blamed on this one dev (e.g. a "54 ETH claimed" history that isn't theirs).
  const realDevWallet = feeStructure?.fee_recipient_wallet || bankrDeployerWallet;
  if (realDevWallet) deployerWallet = realDevWallet.toLowerCase();

  // Step 4: Query Bankrbot creator-fees by deployer wallet
  let creatorFees = null;
  if (deployerWallet) {
    try {
      const feesRes = srcBankr ? await fetch(`https://api.bankr.bot/public/doppler/creator-fees/${deployerWallet}?days=90`) : null;
      if (feesRes && feesRes.ok) {
        const feesData = await feesRes.json();
        const tokens = feesData.tokens || [];
        if (Array.isArray(tokens) && tokens.length > 0) {
          isBankrToken = true;
          // Find this specific token
          const thisToken = tokens.find(t =>
            (t.tokenAddress || t.address || '').toLowerCase() === tokenAddress.toLowerCase()
          );
          if (thisToken) {
            const claimedPair = pickFeePair(thisToken.claimed);
            const claimablePair = pickFeePair(thisToken.claimable);
            creatorFees = {
              claimed_usd: parseFloat(thisToken.claimed?.totalUsd || 0),
              claimable_usd: parseFloat(thisToken.claimable?.totalUsd || 0),
              claimed_weth: claimedPair.weth || '0',
              claimable_weth: claimablePair.weth || '0',
              claimed_token: claimedPair.token || '0',
              claimable_token: claimablePair.token || '0',
              token_label: tokenSymbol,
              claim_count: thisToken.claimed?.count || 0,
            };
            if (!tokenName) { tokenName = thisToken.tokenName || thisToken.name; tokenSymbol = thisToken.tokenSymbol || thisToken.symbol; }
          }

          // Also check all tokens for this wallet for more data
          const allTokensFees = {
            total_claimed: tokens.reduce((s,t) => s+parseFloat(t.claimed?.totalUsd||0), 0).toFixed(2),
            total_claimable: tokens.reduce((s,t) => s+parseFloat(t.claimable?.totalUsd||0), 0).toFixed(2),
            token_count: tokens.length,
          };
          creatorFees = { ...creatorFees, ...allTokensFees };
        }
      }
    } catch (e) {}
  }

  // Step 5: Check dev sold — only txs TO known DEX routers on Base (precise)
  const DEX_ROUTERS = new Set([
    // Uniswap V2
    '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24',
    // Uniswap V3 SwapRouter
    '0x2626664c2603336e57b271c5c0b26f421741e481',
    // Uniswap V3 SwapRouter02
    '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
    // Uniswap UniversalRouter
    '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad',
    // Aerodrome Router
    '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43',
    // Aerodrome SlipstreamRouter
    '0xbe6d8da3c583d5182af3317a6b8f1b98dd37f5ed',
    // Doppler (Bankrbot) router
    '0x6ff5693b99212da76ad316178a184ab56d299b43',
  ]);

  let devSold = { sold: false };
  if (deployerWallet) {
    try {
      const transfersRes = await alchemyRpc(ALCHEMY_KEY, 'alchemy_getAssetTransfers', [{
        fromAddress: deployerWallet,
        contractAddresses: [tokenAddress],
        category: ['erc20'],
        order: 'desc',
        withMetadata: true,
        excludeZeroValue: true,
        maxCount: '0x3e8',
      }]);
      const allOut = transfersRes?.transfers || [];
      // Candidate sells: token transfers to a known DEX router.
      // BUT launch liquidity seeding also goes to the Doppler router, so a router
      // destination alone is not a sell. A real sell returns WETH/ETH to the dev in
      // the SAME tx; liquidity seeding returns nothing. Match by tx hash to be sure.
      const candidates = allOut.filter(tx => DEX_ROUTERS.has((tx.to || '').toLowerCase()));
      let sells = [];
      if (candidates.length > 0) {
        const WETH_BASE = '0x4200000000000000000000000000000000000006';
        const proceeds = new Set();
        try {
          const wIn = await alchemyRpc(ALCHEMY_KEY, 'alchemy_getAssetTransfers', [{
            toAddress: deployerWallet, contractAddresses: [WETH_BASE], category: ['erc20'],
            order: 'desc', excludeZeroValue: true, maxCount: '0x3e8',
          }]);
          (wIn?.transfers || []).forEach(t => { if (t.hash) proceeds.add(t.hash.toLowerCase()); });
          const eIn = await alchemyRpc(ALCHEMY_KEY, 'alchemy_getAssetTransfers', [{
            toAddress: deployerWallet, category: ['external', 'internal'],
            order: 'desc', excludeZeroValue: true, maxCount: '0x3e8',
          }]);
          (eIn?.transfers || []).forEach(t => { if (t.hash) proceeds.add(t.hash.toLowerCase()); });
        } catch (e) {}
        // keep only router transfers that paid WETH/ETH back to the dev = actual sells
        sells = candidates.filter(tx => tx.hash && proceeds.has(tx.hash.toLowerCase()));
      }
      if (sells.length > 0) {
        const total = sells.reduce((s, tx) => s + (tx.value || 0), 0);
        const fmt = n => n<1000?n.toFixed(2):n<1e6?`${(n/1000).toFixed(1)}K`:`${(n/1e6).toFixed(1)}M`;
        const fmtDate = ts => new Date(ts).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
        devSold = {
          sold: true,
          sell_count: sells.length,
          total_sold: fmt(total),
          first_sell: fmtDate(sells[sells.length-1].metadata?.blockTimestamp),
          last_sell: fmtDate(sells[0].metadata?.blockTimestamp),
        };
      }
    } catch (e) {}
  }

  // Step 6: Dev claim — ETH received by deployer from pool/contract (fee claims)
  // Bankrbot/Doppler claims arrive as internal ETH + sometimes external from pool
  let devClaim = { claimed: false };
  if (deployerWallet) {
    try {
      const [claimResInt, claimResExt] = await Promise.all([
        alchemyRpc(ALCHEMY_KEY, 'alchemy_getAssetTransfers', [{
          toAddress: deployerWallet,
          category: ['internal'],
          order: 'desc',
          withMetadata: true,
          excludeZeroValue: true,
          maxCount: '0x64',
        }]),
        alchemyRpc(ALCHEMY_KEY, 'alchemy_getAssetTransfers', [{
          toAddress: deployerWallet,
          category: ['external'],
          order: 'desc',
          withMetadata: true,
          excludeZeroValue: true,
          maxCount: '0x64',
        }]),
      ]);

      const intClaims = claimResInt?.transfers || [];
      // External: exclude self-sends, keep only significant incoming ETH (>0.001)
      const extClaims = (claimResExt?.transfers || []).filter(tx =>
        tx.from?.toLowerCase() !== deployerWallet.toLowerCase() && (tx.value || 0) > 0.001
      );

      // Merge & deduplicate by hash
      const seen = new Set();
      let allClaims = [...intClaims, ...extClaims].filter(tx => {
        if (seen.has(tx.hash)) return false;
        seen.add(tx.hash);
        return true;
      });

      // A fee claim is paid out BY A CONTRACT (the pool / fee locker). Plain ETH sent
      // from another wallet (gas funding, a transfer from an exchange) is NOT a claim,
      // so require the sender to be a contract. Kills "dev claimed" false positives.
      const senders = [...new Set(allClaims.map(tx => (tx.from || '').toLowerCase()).filter(Boolean))];
      const isContractSrc = {};
      await Promise.all(senders.map(async addr => {
        try {
          const code = await alchemyRpc(ALCHEMY_KEY, 'eth_getCode', [addr, 'latest']);
          isContractSrc[addr] = !!(code && code !== '0x' && code.length > 2);
        } catch (e) { isContractSrc[addr] = false; }
      }));
      allClaims = allClaims
        .filter(tx => isContractSrc[(tx.from || '').toLowerCase()])
        .sort((a, b) => new Date(b.metadata?.blockTimestamp) - new Date(a.metadata?.blockTimestamp));

      if (allClaims.length > 0) {
        const totalEth = allClaims.reduce((s, tx) => s + (tx.value || 0), 0);
        const fmtDate = ts => new Date(ts).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
        devClaim = {
          claimed: true,
          claim_count: allClaims.length,
          total_eth: totalEth.toFixed(4),
          last_claim: fmtDate(allClaims[0].metadata?.blockTimestamp),
        };
      }
    } catch (e) {}
  }

  return {
    is_bankr_token: isBankrToken,
    token_address: tokenAddress,
    token_name: tokenName || 'Unknown Token',
    token_symbol: tokenSymbol || '???',
    token_supply: tokenSupply,
    deployer_wallet: deployerWallet,
    deployer_x_username: deployerXUsername,
    fee_recipient: feeRecipient,
    fee_structure: feeStructure,
    deployer_is_recipient: (() => {
      // ONLY trust Bankr launches deployer. On-chain resolved deployer is unreliable
      // (it's the Privy relayer/factory wallet, not the user's wallet).
      const dep = bankrDeployerWallet; // null if token not in recent launches
      const fr = feeStructure?.fee_recipient_wallet || feeRecipient?.wallet;
      if (!dep || !fr) return null; // unknown — don't badge PleaseBro
      return dep.toLowerCase() === fr.toLowerCase();
    })(),
    unclaimed_fees: unclaimedFees,
    creator_fees: creatorFees,
    dev_sold: devSold,
    dev_claim: devClaim,
  };
}

// ── Backend lookup by username ──
async function fetchLensProfile(username) {
  const { LENS_API_URL } = await getConfig();
  if (!LENS_API_URL) throw new Error('No API URL');
  const res = await fetch(`${LENS_API_URL}/api/lookup?username=${encodeURIComponent(username)}`);
  if (!res.ok) throw new Error('API failed');
  const data = await res.json();
  return data.data || data;
}

// ── Launch lookup by username ──
// Backend /api/lookup can lag for tokens launched seconds ago. The live Bankrbot
// launches feed (same source the Live Feed uses) is real-time, so match the handle
// against it and return any token addresses this dev just launched.
async function fetchLaunchByUsername(username) {
  username = String(username || '').toLowerCase().replace(/^@/, '').trim();
  if (!username) return { found: false, addresses: [] };
  try {
    const r = await fetch('https://api.bankr.bot/token-launches?limit=100');
    if (!r.ok) return { found: false, addresses: [] };
    const data = await r.json();
    const launches = Array.isArray(data) ? data : (data.launches || []);
    const addrs = [];
    for (const t of launches) {
      const dep = String((t.deployer && t.deployer.xUsername) || '').toLowerCase();
      const fee = String((t.feeRecipient && t.feeRecipient.xUsername) || '').toLowerCase();
      if (dep === username || fee === username) {
        const a = String(t.tokenAddress || t.address || '').toLowerCase();
        if (/^0x[0-9a-f]{40}$/.test(a) && !addrs.includes(a)) addrs.push(a);
      }
    }
    return { found: addrs.length > 0, addresses: addrs };
  } catch (e) {
    return { found: false, addresses: [] };
  }
}

// ── GitHub ──
async function fetchGitHub(username) {
  const { GITHUB_TOKEN } = await getConfig();
  const headers = { 'Accept': 'application/vnd.github+json', 'Authorization': `Bearer ${GITHUB_TOKEN}` };
  const [uR, rR] = await Promise.all([
    fetch(`https://api.github.com/users/${username}`, { headers }),
    fetch(`https://api.github.com/users/${username}/repos?sort=updated&per_page=6`, { headers }),
  ]);
  if (!uR.ok) throw new Error('Not found');
  const user = await uR.json();
  const repos = rR.ok ? await rR.json() : [];
  const langs = [...new Set(repos.map(r => r.language).filter(Boolean))];
  return { login: user.login, public_repos: user.public_repos, stars: repos.reduce((s,r)=>s+r.stargazers_count,0), languages: langs.slice(0,4), last_commit: repos[0]?.updated_at ? timeAgo(new Date(repos[0].updated_at)) : 'Unknown', top_repos: repos.slice(0,4).map(r=>({name:r.name,language:r.language})) };
}

function timeAgo(date) {
  const d = Math.floor((Date.now()-date.getTime())/86400000);
  return d===0?'today':d<30?`${d}d ago`:d<365?`${Math.floor(d/30)}mo ago`:`${Math.floor(d/365)}y ago`;
}

// Fetch username (screen name) history via backend → memory.lol
async function fetchUsernameHistory(username) {
  const { LENS_API_URL } = await getConfig();
  const base = LENS_API_URL || 'https://lnsx.io';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(`${base}/api/lookup?username_history=${encodeURIComponent(username)}`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const j = await r.json();
    return j.success ? j : null;
  } catch (e) {
    clearTimeout(t);
    return null;
  }
}

// ── Launch alerts ────────────────────────────────────────────────────────────
// Poll the trending feed every few minutes and fire a Chrome notification when a
// watchlisted dev launches a new token (their latest_token changes).
const LENS_ALERT_ALARM = 'lens-launch-check';

function ensureAlertAlarm() {
  try { chrome.alarms.create(LENS_ALERT_ALARM, { periodInMinutes: 3 }); } catch (e) {}
}
chrome.runtime.onInstalled.addListener(ensureAlertAlarm);
if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(ensureAlertAlarm);
ensureAlertAlarm();

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm && alarm.name === LENS_ALERT_ALARM) checkLaunches();
});

async function checkLaunches() {
  try {
    const store = await chrome.storage.local.get(['LENS_WATCHLIST', 'LENS_SEEN_TOKENS', 'LENS_SETTINGS', 'LENS_NOTIF_TARGETS']);
    const settings = store.LENS_SETTINGS || {};
    if (settings.launch_alerts === false) return;            // respect the toggle
    const watchlist = Array.isArray(store.LENS_WATCHLIST) ? store.LENS_WATCHLIST : [];
    if (!watchlist.length) return;

    const r = await fetch('https://lnsx.io/api/trending?limit=100');
    if (!r.ok) return;
    const data = await r.json();
    const devs = (data && data.devs) || [];
    if (!devs.length) return;

    const byUser = new Map(), byWallet = new Map();
    devs.forEach(d => {
      if (d.x_username) byUser.set(d.x_username.toLowerCase(), d);
      if (d.deployer_wallet) byWallet.set(d.deployer_wallet.toLowerCase(), d);
    });

    const seen = store.LENS_SEEN_TOKENS || {};
    const targets = store.LENS_NOTIF_TARGETS || {};
    let dirty = false;

    for (const w of watchlist) {
      const uname = (w.username || '').toLowerCase();
      const wallet = (w.wallet || '').toLowerCase();
      const dev = (uname && byUser.get(uname)) || (wallet && byWallet.get(wallet));
      if (!dev || !dev.latest_token) continue;
      const key = uname ? 'x:' + uname : 'w:' + wallet;
      const prev = seen[key];
      if (prev === undefined) { seen[key] = dev.latest_token; dirty = true; continue; } // baseline only
      if (prev !== dev.latest_token) {
        seen[key] = dev.latest_token; dirty = true;
        fireLaunchNotification(dev, targets);
      }
    }
    if (dirty) await chrome.storage.local.set({ LENS_SEEN_TOKENS: seen, LENS_NOTIF_TARGETS: targets });
  } catch (e) {}
}

function fireLaunchNotification(dev, targets) {
  const who = dev.x_username ? '@' + dev.x_username
    : (dev.deployer_wallet ? dev.deployer_wallet.slice(0, 6) + '…' + dev.deployer_wallet.slice(-4) : 'A tracked dev');
  const id = 'lens-launch-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  targets[id] = dev.x_username ? 'https://x.com/' + dev.x_username : 'https://bankr.bot';
  const ks = Object.keys(targets);
  if (ks.length > 30) ks.slice(0, ks.length - 30).forEach(k => delete targets[k]);
  try {
    chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: '\u{1F680} New launch: $' + dev.latest_token,
      message: who + ' just launched a new token on Bankrbot.',
      priority: 2,
    });
  } catch (e) {}
}

if (chrome.notifications && chrome.notifications.onClicked) {
  chrome.notifications.onClicked.addListener(id => {
    if (!id || id.indexOf('lens-launch-') !== 0) return;
    chrome.storage.local.get(['LENS_NOTIF_TARGETS'], r => {
      const map = (r && r.LENS_NOTIF_TARGETS) || {};
      const url = map[id];
      if (url) { try { chrome.tabs.create({ url }); } catch (e) {} }
      try { chrome.notifications.clear(id); } catch (e) {}
    });
  });
}

// ── Cabal Wallet (Level 2): common-funder clustering of early buyers ──
// Finds the earliest token receivers (EOAs only), traces who first funded each
// with ETH, then groups wallets sharing a funder into clusters. Flags dev-funded.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); } catch (e) { out[idx] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
  return out;
}

async function fetchCabal(tokenAddress, deployerWallet) {
  if (!tokenAddress) throw new Error('No token address');
  const token = String(tokenAddress).toLowerCase();
  const dev = deployerWallet ? String(deployerWallet).toLowerCase() : null;
  const ZERO = '0x0000000000000000000000000000000000000000';

  // 1) earliest token transfers -> early receivers
  const tr = await alchemyRpc(null, 'alchemy_getAssetTransfers', [{
    contractAddresses: [token], category: ['erc20'], order: 'asc',
    excludeZeroValue: true, maxCount: '0x3c',
  }]);
  const transfers = (tr && tr.transfers) || [];
  const exclude = new Set([token, ZERO]);
  if (dev) exclude.add(dev);
  const seen = new Set();
  const candidates = [];
  for (const t of transfers) {
    const to = (t.to || '').toLowerCase();
    if (!to || exclude.has(to) || seen.has(to)) continue;
    seen.add(to); candidates.push(to);
    if (candidates.length >= 25) break;
  }
  if (!candidates.length) return { token, scanned: 0, clusters: [], note: 'No early holders found.' };

  // 2) keep EOAs only (drop pool / router / contracts)
  const codes = await mapLimit(candidates, 5, (a) => alchemyRpc(null, 'eth_getCode', [a, 'latest']));
  const eoas = candidates.filter((a, i) => { const c = codes[i]; return !c || c === '0x' || c === '0x0'; }).slice(0, 20);
  if (!eoas.length) return { token, scanned: 0, clusters: [], note: 'No wallet (EOA) buyers among early holders.' };

  // 3) earliest ETH funder of each EOA
  const funders = await mapLimit(eoas, 5, async (a) => {
    const inc = await alchemyRpc(null, 'alchemy_getAssetTransfers', [{
      toAddress: a, category: ['external', 'internal'], order: 'asc',
      excludeZeroValue: true, maxCount: '0xa',
    }]);
    const list = (inc && inc.transfers) || [];
    for (const x of list) {
      const f = (x.from || '').toLowerCase();
      if (f && f !== a && f !== ZERO) return f;
    }
    return null;
  });

  // 4) cluster by shared funder
  const groups = new Map();
  eoas.forEach((a, i) => {
    const f = funders[i];
    if (!f) return;
    if (!groups.has(f)) groups.set(f, []);
    groups.get(f).push(a);
  });
  const clusters = [];
  for (const [funder, wallets] of groups.entries()) {
    const isDev = !!(dev && funder === dev);
    if (wallets.length >= 2 || isDev) clusters.push({ funder, wallets, count: wallets.length, funder_is_dev: isDev });
  }
  if (!clusters.length) return { token, scanned: eoas.length, clusters: [], note: 'No shared-funder clusters among early buyers.' };

  // 5) % of supply held by each cluster (now)
  let totalSupply = 0n;
  try { totalSupply = BigInt(await alchemyRpc(null, 'eth_call', [{ to: token, data: '0x18160ddd' }, 'latest']) || '0x0'); } catch (e) {}
  const balOf = async (addr) => {
    try {
      const data = '0x70a08231' + addr.slice(2).padStart(64, '0');
      return BigInt(await alchemyRpc(null, 'eth_call', [{ to: token, data }, 'latest']) || '0x0');
    } catch (e) { return 0n; }
  };
  for (const c of clusters) {
    const bals = await mapLimit(c.wallets, 5, balOf);
    const sum = bals.reduce((s, b) => s + (b || 0n), 0n);
    c.supply_pct = totalSupply > 0n ? Number((sum * 10000n) / totalSupply) / 100 : null;
  }
  clusters.sort((a, b) => (Number(b.funder_is_dev) - Number(a.funder_is_dev)) || ((b.supply_pct || 0) - (a.supply_pct || 0)) || (b.count - a.count));
  const total_pct = Math.round(clusters.reduce((s, c) => s + (c.supply_pct || 0), 0) * 100) / 100;
  return { token, scanned: eoas.length, clusters, total_pct };
}

// Token Health — lightweight, reliable: how much of supply the deployer still holds.
// (Full liquidity / holder distribution needs an indexer; this is the key dump-risk signal.)
async function fetchTokenHealth(token, deployer) {
  if (!token || !/^0x[0-9a-fA-F]{40}$/.test(token)) return { success: false, error: 'no token' };
  let totalSupply = 0n, symbol = '';
  try {
    const meta = await alchemyRpc(null, 'alchemy_getTokenMetadata', [token]);
    if (meta) symbol = meta.symbol || meta.name || '';
  } catch (e) {}
  try { totalSupply = BigInt(await alchemyRpc(null, 'eth_call', [{ to: token, data: '0x18160ddd' }, 'latest']) || '0x0'); } catch (e) {}
  const balOf = async (addr) => {
    if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) return null;
    try {
      const data = '0x70a08231' + addr.slice(2).padStart(64, '0');
      return BigInt(await alchemyRpc(null, 'eth_call', [{ to: token, data }, 'latest']) || '0x0');
    } catch (e) { return null; }
  };
  const devBal = await balOf(deployer);
  const pct = (b) => (b != null && totalSupply > 0n) ? Number((b * 10000n) / totalSupply) / 100 : null;
  return {
    success: totalSupply > 0n,
    symbol,
    total_supply: totalSupply.toString(),
    dev_pct: pct(devBal),
    has_supply: totalSupply > 0n,
  };
}

// Serial-rugger linking — trace who funded the deployer (first incoming ETH),
// then find the OTHER wallets that same funder also seeded. A small fan-out from
// one personal funder hints at a multi-wallet operator; a huge fan-out is a CEX.
async function fetchDevFunding(deployer) {
  if (!deployer || !/^0x[0-9a-fA-F]{40}$/.test(deployer)) return { success: false, error: 'no deployer' };
  const dev = deployer.toLowerCase();
  let funder = null;
  try {
    const incoming = await alchemyRpc(null, 'alchemy_getAssetTransfers', [{
      fromBlock: '0x0', toBlock: 'latest', toAddress: dev, category: ['external'], order: 'asc', maxCount: '0xa',
    }]);
    const inc = (incoming && incoming.transfers) || [];
    funder = inc.length ? (inc[0].from || null) : null;
  } catch (e) {}
  if (!funder) return { success: true, funder: null, siblings: [], fanout: 0 };

  let siblings = [];
  try {
    const outgoing = await alchemyRpc(null, 'alchemy_getAssetTransfers', [{
      fromBlock: '0x0', toBlock: 'latest', fromAddress: funder, category: ['external'], order: 'asc', maxCount: '0x64',
    }]);
    const out = (outgoing && outgoing.transfers) || [];
    const set = new Set();
    for (const t of out) {
      const to = (t.to || '').toLowerCase();
      if (to && to !== dev) set.add(to);
    }
    siblings = [...set];
  } catch (e) {}

  return { success: true, funder, fanout: siblings.length, siblings: siblings.slice(0, 40) };
}
