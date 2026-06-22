// api/b20-skill.js
// LENS B20 skill — backing API for agents (Bankr, etc.) to deploy B20 tokens on Base.
// Live Base RPC. No auth. Mirrors the SKILL.md action surface.
//
// Deploy this on the Lens backend (Vercel). It will be reachable at:
//   https://lens-liard.vercel.app/api/b20-skill   (and your api.lnsx.io alias)
//
// Uses viem (already a dependency via clanker-sdk). No new packages needed.
//
// =====================================================================================
//  ⚠️  PRE-LAUNCH NOTE — READ BEFORE MAINNET
//  B20 goes live with the Base Beryl upgrade on 25 Jun 2026, 18:00 UTC.
//  The `prepare` action builds an EIP-1559 tx + ABI calldata for the B20 factory.
//  The exact factory ADDRESS and the create() ABI SIGNATURE below are best-known
//  values and MUST be confirmed against Base's official B20 docs before you sign a
//  real mainnet tx. Everything else (info/gas/balance/token_info/validate/receipt)
//  uses standard Base RPC and is accurate today.
// =====================================================================================

import {
  createPublicClient, http, parseAbi, encodeFunctionData,
  formatEther, formatGwei, isAddress, getAddress, numberToHex,
} from 'viem';
import { base, baseSepolia } from 'viem/chains';

// ---- CONFIG (verify factory + signature against Base official B20 docs) -------------
const CONFIG = {
  factory: {
    // Singleton B20 factory precompile. Base spec references a 0xB20f-prefixed singleton.
    // Confirm the exact address from Base docs before mainnet.
    mainnet: '0x4200000000000000000000000000000000000B20',
    sepolia: '0x4200000000000000000000000000000000000B20',
  },
  // Assumed create() signature: (name, symbol, decimals, supplyCap, admin, variant, policyBits, contractURI)
  createAbi: parseAbi([
    'function create(string name,string symbol,uint8 decimals,uint256 supplyCap,address admin,uint8 variant,uint8 policyBits,string contractURI) returns (address)',
  ]),
  deployGas: 350000n, // gas-limit estimate for the factory call
};

const VARIANT = { asset: 0, stablecoin: 1 };
const POLICY_BIT = { allowlist: 1, blocklist: 2, freeze: 4 }; // bit0/1/2

const ERC20_ABI = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]);

const RPC = {
  mainnet: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
  sepolia: process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org',
};
const CHAIN = { mainnet: base, sepolia: baseSepolia };

function client(network = 'mainnet') {
  const net = network === 'sepolia' ? 'sepolia' : 'mainnet';
  return createPublicClient({ chain: CHAIN[net], transport: http(RPC[net]) });
}

// ---- helpers ------------------------------------------------------------------------
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function send(res, code, obj) {
  cors(res);
  res.setHeader('Content-Type', 'application/json');
  res.status(code).json(obj);
}
function body(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body;
}

async function gasBreakdown(c) {
  const [block, fees] = await Promise.all([c.getBlock(), c.estimateFeesPerGas()]);
  const baseFee = block.baseFeePerGas ?? 0n;
  let tips = null;
  try {
    const fh = await c.getFeeHistory({ blockCount: 5, rewardPercentiles: [25, 50, 75] });
    const last = (fh.reward && fh.reward[fh.reward.length - 1]) || [];
    tips = {
      p25Gwei: last[0] != null ? formatGwei(last[0]) : null,
      p50Gwei: last[1] != null ? formatGwei(last[1]) : null,
      p75Gwei: last[2] != null ? formatGwei(last[2]) : null,
    };
  } catch { /* feeHistory optional */ }
  const costWei = fees.maxFeePerGas * CONFIG.deployGas;
  return {
    baseFeeGwei: formatGwei(baseFee),
    maxFeePerGas: numberToHex(fees.maxFeePerGas),
    maxPriorityFeePerGas: numberToHex(fees.maxPriorityFeePerGas),
    maxFeePerGasGwei: formatGwei(fees.maxFeePerGas),
    tips,
    deployGasLimit: Number(CONFIG.deployGas),
    estDeployCostEth: formatEther(costWei),
  };
}

function validateConfig(p) {
  const errs = [];
  if (!p.name || String(p.name).length > 64) errs.push('name required, max 64 chars');
  if (!p.symbol || !/^[A-Za-z0-9]{1,11}$/.test(String(p.symbol))) errs.push('symbol required, max 11 alphanumeric chars');
  const variant = (p.variant || 'asset').toLowerCase();
  if (!(variant in VARIANT)) errs.push("variant must be 'asset' or 'stablecoin'");
  let decimals = p.decimals == null ? 18 : Number(p.decimals);
  if (variant === 'stablecoin') decimals = 6;
  if (decimals < 6 || decimals > 18) errs.push('decimals must be 6-18');
  const adminless = !!p.adminless;
  if (!adminless && !(p.admin && isAddress(p.admin))) errs.push("admin (0x...) required unless adminless:true");
  const supplyCap = p.supply_cap != null ? String(p.supply_cap) : '0';
  if (!/^\d+$/.test(supplyCap)) errs.push('supply_cap must be an integer string ("0" = uncapped)');
  const pol = p.policies || {};
  let policyBits = 0;
  for (const k of Object.keys(pol)) {
    if (pol[k] && POLICY_BIT[k]) policyBits |= POLICY_BIT[k];
  }
  return { errs, variant, decimals, adminless, supplyCap, policyBits, pol };
}

// LENS twist: flag config choices that LENS's own scanner would treat as risky.
function lensCheck({ adminless, pol }) {
  const flags = [];
  if (pol && pol.freeze) flags.push('freeze policy ON — admin can freeze accounts and seize balances (centralization risk)');
  if (!adminless) flags.push('admin retains mint + policy control — consider adminless:true after setup to renounce');
  if (pol && pol.allowlist) flags.push('allowlist ON — only allowlisted wallets can hold/receive (restricted transfers)');
  const verdict = flags.length === 0 ? 'CLEAR'
    : (pol && pol.freeze) ? 'CAUTION' : 'CAUTION';
  return {
    verdict,
    note: flags.length === 0
      ? 'no centralization flags — this config reads clean'
      : 'these settings would show as risk signals on a LENS scan',
    flags,
  };
}

// ---- handler ------------------------------------------------------------------------
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { cors(res); return res.status(204).end(); }

  try {
    const isGet = req.method === 'GET';
    const p = isGet ? (req.query || {}) : body(req);
    const action = String(p.action || (isGet ? 'info' : '')).toLowerCase();
    const network = (p.network === 'sepolia') ? 'sepolia' : 'mainnet';
    const c = client(network);
    const factory = CONFIG.factory[network];

    if (action === 'manifest') {
      return send(res, 200, {
        name: 'lens-b20',
        actions: ['info', 'gas', 'balance', 'token_info', 'validate', 'prepare', 'receipt'],
        networks: ['mainnet', 'sepolia'],
        auth: 'none',
        endpoint: 'https://lens-liard.vercel.app/api/b20-skill',
      });
    }

    if (action === 'info') {
      const [blockNumber, gas] = await Promise.all([c.getBlockNumber(), gasBreakdown(c)]);
      return send(res, 200, {
        ok: true,
        chain: { network, chainId: CHAIN[network].id, blockNumber: Number(blockNumber) },
        b20: {
          factory,
          activates: '2026-06-25T18:00:00Z (Base Beryl, mainnet)',
          variants: {
            asset: 'configurable decimals 6-18, rebasing, issuer metadata',
            stablecoin: 'fixed 6 decimals, currency code',
          },
          policies: ['allowlist', 'blocklist', 'freeze'],
          erc20Compatible: true,
        },
        gas,
      });
    }

    if (action === 'gas') {
      return send(res, 200, { ok: true, network, gas: await gasBreakdown(c) });
    }

    if (action === 'balance') {
      if (!p.address || !isAddress(p.address)) return send(res, 400, { ok: false, error: 'valid address required' });
      const addr = getAddress(p.address);
      const wei = await c.getBalance({ address: addr });
      const out = { ok: true, network, address: addr, eth: formatEther(wei) };
      if (p.token && isAddress(p.token)) {
        try {
          const bal = await c.readContract({ address: getAddress(p.token), abi: ERC20_ABI, functionName: 'balanceOf', args: [addr] });
          out.token = { address: getAddress(p.token), rawBalance: bal.toString() };
        } catch { out.token = { address: getAddress(p.token), error: 'could not read balanceOf' }; }
      }
      return send(res, 200, out);
    }

    if (action === 'token_info') {
      if (!p.address || !isAddress(p.address)) return send(res, 400, { ok: false, error: 'valid token address required' });
      const t = getAddress(p.address);
      const [name, symbol, decimals, totalSupply] = await Promise.all([
        c.readContract({ address: t, abi: ERC20_ABI, functionName: 'name' }).catch(() => null),
        c.readContract({ address: t, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => null),
        c.readContract({ address: t, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => null),
        c.readContract({ address: t, abi: ERC20_ABI, functionName: 'totalSupply' }).catch(() => null),
      ]);
      const out = { ok: true, network, token: t, name, symbol, decimals: decimals != null ? Number(decimals) : null, totalSupply: totalSupply != null ? totalSupply.toString() : null };
      if (p.holder && isAddress(p.holder)) {
        const bal = await c.readContract({ address: t, abi: ERC20_ABI, functionName: 'balanceOf', args: [getAddress(p.holder)] }).catch(() => null);
        out.holderBalance = bal != null ? bal.toString() : null;
      }
      return send(res, 200, out);
    }

    if (action === 'validate') {
      const v = validateConfig(p);
      const gas = await gasBreakdown(c);
      let chainCheck = null;
      if (v.adminless ? false : (p.admin && isAddress(p.admin))) {
        const wei = await c.getBalance({ address: getAddress(p.admin) });
        const need = (await c.estimateFeesPerGas()).maxFeePerGas * CONFIG.deployGas;
        chainCheck = {
          admin: getAddress(p.admin),
          adminEth: formatEther(wei),
          estDeployCostEth: formatEther(need),
          canAfford: wei >= need,
        };
      }
      return send(res, 200, {
        ok: v.errs.length === 0,
        network,
        valid: v.errs.length === 0,
        errors: v.errs,
        config: { name: p.name, symbol: p.symbol, variant: v.variant, decimals: v.decimals, supplyCap: v.supplyCap, adminless: v.adminless, policyBits: v.policyBits },
        lensCheck: lensCheck(v),
        chainCheck,
        gas,
      });
    }

    if (action === 'prepare') {
      const v = validateConfig(p);
      if (v.errs.length) return send(res, 400, { ok: false, errors: v.errs });

      const admin = v.adminless ? '0x0000000000000000000000000000000000000000' : getAddress(p.admin);
      const args = [
        String(p.name),
        String(p.symbol),
        v.decimals,
        BigInt(v.supplyCap),          // NOTE: confirm whether supplyCap is whole-tokens or base-units in Base spec
        admin,
        VARIANT[v.variant],
        v.policyBits,
        String(p.contract_uri || ''),
      ];
      const data = encodeFunctionData({ abi: CONFIG.createAbi, functionName: 'create', args });

      const fees = await c.estimateFeesPerGas();
      let nonce = 0;
      if (!v.adminless) nonce = await c.getTransactionCount({ address: admin });

      return send(res, 200, {
        ok: true,
        status: 'prepared',
        network,
        note: 'Unsigned EIP-1559 tx. Verify factory + create() ABI against Base official B20 docs, then sign & broadcast once B20 activates (25 Jun 2026 18:00 UTC).',
        config: { name: p.name, symbol: p.symbol, variant: v.variant, decimals: v.decimals, supplyCap: v.supplyCap, policyBits: v.policyBits, adminless: v.adminless },
        lensCheck: lensCheck(v),
        deployment: {
          factory,
          abiSig: 'create(string,string,uint8,uint256,address,uint8,uint8,string)',
          tx: {
            type: '0x02',
            chainId: numberToHex(CHAIN[network].id),
            to: factory,
            from: v.adminless ? null : admin,
            value: '0x0',
            data,
            gas: numberToHex(CONFIG.deployGas),
            maxFeePerGas: numberToHex(fees.maxFeePerGas),
            maxPriorityFeePerGas: numberToHex(fees.maxPriorityFeePerGas),
            nonce: numberToHex(nonce),
          },
        },
      });
    }

    if (action === 'receipt') {
      if (!p.tx_hash) return send(res, 400, { ok: false, error: 'tx_hash required' });
      let r;
      try { r = await c.getTransactionReceipt({ hash: p.tx_hash }); }
      catch { return send(res, 200, { ok: true, status: 'pending', tx_hash: p.tx_hash }); }
      // best-effort token address: contractAddress, else first log address
      let token = r.contractAddress || (r.logs && r.logs[0] && r.logs[0].address) || null;
      return send(res, 200, {
        ok: true,
        status: r.status === 'success' ? 'success' : 'failed',
        network,
        tx_hash: p.tx_hash,
        blockNumber: Number(r.blockNumber),
        gasUsed: r.gasUsed ? r.gasUsed.toString() : null,
        tokenAddress: token,
        note: token ? 'tokenAddress is best-effort from logs — confirm against the B20 factory event ABI' : undefined,
        logCount: r.logs ? r.logs.length : 0,
      });
    }

    return send(res, 400, { ok: false, error: `unknown action '${action}'`, actions: ['info', 'gas', 'balance', 'token_info', 'validate', 'prepare', 'receipt', 'manifest'] });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e && e.message ? e.message : e) });
  }
}
