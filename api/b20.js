// b20.js — LENS scanner for B20, Base's native token standard (Beryl upgrade)
// reads on-chain risk signals straight from the B20 precompile token and the
// B20Factory precompile, then maps them to a CLEAR / CAUTION / STOP verdict.
//
// B20 tokens are precompiles, not normal ERC-20 contracts, so a Bankr/Clanker
// style "deployer wallet" lookup will miss them. this module is how LENS sees
// them. everything here is a stateless eth_call, no key, read only.
//
// note: B20 is gated by Base's ActivationRegistry. until it is activated on a
// chain, factory.isB20 returns false and scanB20 cleanly reports { isB20:false }
// so the caller just falls through to existing logic. nothing breaks pre-launch.

const B20_FACTORY = '0xB20f000000000000000000000000000000000000';

// function selectors (first 4 bytes of keccak256 of the signature)
const SEL = {
  isB20:       '0xfa19b927', // isB20(address) on the factory
  supplyCap:   '0x8f770ad0', // supplyCap()
  policyId:    '0xdb3de624', // policyId(bytes32)
  isPaused:    '0xbc61e733', // isPaused(uint8 feature)
  name:        '0x06fdde03', // name()
  symbol:      '0x95d89b41', // symbol()
  decimals:    '0x313ce567', // decimals()
  totalSupply: '0x18160ddd', // totalSupply()
  currency:    '0xe5a6b10f', // currency()  (stablecoin variant only)
};

// keccak256 of the policy-scope strings (full 32 bytes, no 0x for calldata)
const SCOPE = {
  TRANSFER_SENDER:   'b81736c875ab819dd97f59f2a6542cfb731ad52b4ae15a6f24df2fb02b0327f5',
  TRANSFER_RECEIVER: '8a4b3fa2d8b921852bc0089c6ef0958aa6961897be36fd731330fe2cd23f8363',
  MINT_RECEIVER:     'a0d5ae037e66a09119acf080a1d807abb9b6d03b6b9130eb19f7c1e6bdb8ffc8',
};

// PausableFeature enum: TRANSFER=0, MINT=1, BURN=2
const FEATURE = { TRANSFER: 0, MINT: 1, BURN: 2 };

// type(uint128).max — the "no cap" sentinel and the absolute ceiling for supply
const MAX_UINT128 = (2n ** 128n) - 1n;

const pad32 = (h) => h.replace(/^0x/, '').padStart(64, '0');
const addrArg = (a) => pad32(a.toLowerCase());
const uint8Arg = (n) => pad32(n.toString(16));

async function ethCall(rpcUrl, to, data, ms = 7000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
      signal: ctrl.signal,
    });
    const j = await res.json();
    if (j.error) return null;      // reverted / not callable on this address
    return j.result || null;       // 0x... hex word(s)
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const decUint = (hex) => (!hex || hex === '0x') ? 0n : BigInt(hex);

function decString(hex) {
  if (!hex || hex === '0x') return '';
  const b = hex.replace(/^0x/, '');
  if (b.length < 128) return '';                 // need offset + length words
  const len = parseInt(b.slice(64, 128), 16);
  if (!len) return '';
  return Buffer.from(b.slice(128, 128 + len * 2), 'hex').toString('utf8').replace(/\0+$/, '');
}

// is this address a B20 token? (factory recovers it from the address prefix, never reverts)
export async function isB20(rpcUrl, contract) {
  const res = await ethCall(rpcUrl, B20_FACTORY, SEL.isB20 + addrArg(contract));
  return decUint(res) === 1n;
}

// full risk scan. returns { isB20:false } when the address is not a B20 token.
export async function scanB20(rpcUrl, contract) {
  if (!rpcUrl) return { isB20: false };
  if (!(await isB20(rpcUrl, contract))) return { isB20: false };

  const call = (sel, arg = '') => ethCall(rpcUrl, contract, sel + arg);
  const [nameR, symR, decR, tsR, capR, curR, pSend, pRecv, pMint, pauseT, pauseM, pauseB] =
    await Promise.all([
      call(SEL.name), call(SEL.symbol), call(SEL.decimals), call(SEL.totalSupply),
      call(SEL.supplyCap), call(SEL.currency),
      call(SEL.policyId, SCOPE.TRANSFER_SENDER),
      call(SEL.policyId, SCOPE.TRANSFER_RECEIVER),
      call(SEL.policyId, SCOPE.MINT_RECEIVER),
      call(SEL.isPaused, uint8Arg(FEATURE.TRANSFER)),
      call(SEL.isPaused, uint8Arg(FEATURE.MINT)),
      call(SEL.isPaused, uint8Arg(FEATURE.BURN)),
    ]);

  const supplyCap = decUint(capR);
  const currency = decString(curR);
  const isStablecoin = !!currency;                       // only stablecoin variant declares one

  const state = {
    isB20: true,
    variant: isStablecoin ? 'stablecoin' : 'asset',
    name: decString(nameR),
    symbol: decString(symR),
    decimals: Number(decUint(decR)),
    total_supply: decUint(tsR).toString(),
    currency: currency || null,
    supply_capped: capR != null && supplyCap !== MAX_UINT128,
    supply_cap: (capR != null && supplyCap !== MAX_UINT128) ? supplyCap.toString() : null,
    transfer_gated: decUint(pSend) !== 0n || decUint(pRecv) !== 0n,  // freeze / seize / block surface
    mint_gated: decUint(pMint) !== 0n,
    paused_transfer: decUint(pauseT) === 1n,
    paused_mint: decUint(pauseM) === 1n,
    paused_burn: decUint(pauseB) === 1n,
  };

  return { ...state, ...b20Verdict(state) };
}

// map on-chain state to LENS red lines + verdict
export function b20Verdict(s) {
  const lines = [];
  let level = 0;                                   // 0 clear, 1 caution, 2 stop
  const bump = (n) => { if (n > level) level = n; };

  if (s.paused_transfer) {
    lines.push({ flag: 'STOP', label: 'transfers paused', detail: 'transfers are halted right now, you may not be able to move or sell' });
    bump(2);
  }
  if (s.transfer_gated && s.variant !== 'stablecoin') {
    lines.push({ flag: 'STOP', label: 'freeze and seize', detail: 'transfers are policy gated, the issuer can block or seize balances at will' });
    bump(2);
  }
  if (s.transfer_gated && s.variant === 'stablecoin') {
    lines.push({ flag: 'CAUTION', label: 'compliance controls', detail: 'transfers are policy gated, normal for a regulated stablecoin but the issuer can still freeze accounts' });
    bump(1);
  }
  if (!s.supply_capped) {
    lines.push({ flag: 'CAUTION', label: 'no supply cap', detail: 'supply is uncapped, anyone holding the mint role can mint without limit' });
    bump(1);
  }
  if (s.mint_gated) {
    lines.push({ flag: 'INFO', label: 'mint restricted', detail: 'new supply can only go to allowlisted recipients' });
  }
  if (s.paused_mint || s.paused_burn) {
    const which = [s.paused_mint && 'mint', s.paused_burn && 'burn'].filter(Boolean).join(' and ');
    lines.push({ flag: 'INFO', label: 'partial pause', detail: `${which} currently paused` });
  }

  const verdict = level === 2 ? 'STOP' : level === 1 ? 'CAUTION' : 'CLEAR';
  if (!lines.length) {
    lines.push({ flag: 'CLEAR', label: 'clean B20', detail: 'capped supply, no transfer gating, nothing paused' });
  }
  return { verdict, red_lines: lines };
}
