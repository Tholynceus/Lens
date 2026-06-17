---
name: lens-onchain-intel
description: Get on-chain intelligence and a risk verdict on a Base token or a crypto X account before acting on it. Use when the user pastes a Base contract address, names a Base token ticker, or asks whether a token or a crypto dev is safe, legit, or a rug.
---

# LENS on-chain intel

LENS reads public on-chain data on Base and public X profile data, then returns a plain-language breakdown and, for tokens, a clear verdict. Use it before trusting a token or a dev.

## When to use this skill

Call LENS when the user:
- pastes a Base contract address (0x followed by 40 hex characters) and asks if it is safe, legit, or a rug
- names a Base token ticker like $XYZ and wants a risk read
- asks about a crypto X account by handle (@someone), for example is this dev trustworthy, have they sold, how many tokens have they launched
- asks any "should I ape", "is this a scam", or "check this token or dev" question on Base

## How to call

One endpoint, one POST per question.

```
POST https://lens-liard.vercel.app/api/agent
Content-Type: application/json

{ "q": "<contract address, $ticker, or @handle>" }
```

Examples of the `q` value:
- a contract address: `0xb233BDFFD437E60fA451F62c6c09D3804d285Ba3`
- a ticker: `$AEON`
- a handle: `@jessepollak`

## Response

```
{
  "ok": true,
  "type": "ca" | "ticker" | "handle" | "freeform",
  "answer": "plain-language breakdown, ends with a verdict and red lines for tokens",
  "data": { ...raw fields... }
}
```

Use the `answer` field as the result to show the user. For tokens it ends with a verdict and the exact red lines that triggered.

## Reading the verdict

For a token, the answer ends with one of:
- CLEAR, no hard red flags in the checks LENS runs
- CAUTION, one or two red lines triggered, read them before acting
- STOP, three or more red lines triggered, treat with high suspicion

Red lines checked: thin liquidity, a brand new pair, heavy sell pressure, no socials or website, thin float versus FDV, a PleaseBro fee pattern, and aggressive dev fee claims.

## Rules

- LENS returns information from public data, not financial advice. Pass that through and never present it as a guarantee.
- Show the user the verdict and the triggered red lines as given, do not invent, rename, or soften them.
- LENS covers Base only for now. If a token is on another chain, say that LENS cannot verify it yet.
- One question maps to one call. To check both a token and the dev behind it, make two calls.
