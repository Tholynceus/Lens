// LENS — /api/verdict  (POST)
// Takes the panel's on-chain signals for an X deployer and asks an LLM for a
// one-line risk verdict. Provider-agnostic (any OpenAI-compatible API).
// The API key stays server-side — never ship it in the extension.
//
// Env required:
//   LLM_API_KEY   — your provider key (e.g. Venice key). Server only.
// Env optional:
//   LLM_API_URL   — default 'https://api.venice.ai/api/v1'
//   LLM_MODEL     — default 'llama-3.3-70b' (set to any model your provider serves)

const LLM_KEY = process.env.LLM_API_KEY;
const LLM_URL = (process.env.LLM_API_URL || 'https://api.venice.ai/api/v1').replace(/\/+$/, '');
const LLM_MODEL = process.env.LLM_MODEL || 'llama-3.3-70b';

const SYSTEM = [
  'You are an on-chain risk analyst for crypto token deployers on Base / Bankrbot.',
  'You are given detection signals from the LENS browser extension about one X account / deployer.',
  'Assess rug / scam risk using ONLY the signals provided. Never invent facts not present.',
  'Reply with STRICT JSON only, no markdown, no preamble:',
  '{"level":"LOW|MEDIUM|HIGH","verdict":"<one concise sentence, max 24 words, plain English>"}',
  'Weigh heavily: dev sold, contract address removed from bio, very high fee share, bundled/dev-funded buyers, serial deploys, location mismatch.',
  'If signals are thin or mostly clean, use LOW or MEDIUM and say so briefly.',
].join(' ');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'POST only' });

  if (!LLM_KEY) {
    return res.status(200).json({ success: false, error: 'LLM_API_KEY not configured on the server' });
  }

  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    const username = String(body.username || '').replace(/^@/, '').slice(0, 40);
    const panel = String(body.panel || '').slice(0, 2000);
    const trust = body.trust || null;

    if (!panel && !trust) {
      return res.status(200).json({ success: false, error: 'no signals provided' });
    }

    const userMsg =
      `X account: @${username || 'unknown'}\n` +
      (trust ? `Trust score: ${trust.score}/100 (${trust.label})\n` : '') +
      `LENS signals:\n${panel || '(none)'}`;

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    const r = await fetch(`${LLM_URL}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}` },
      body: JSON.stringify({
        model: LLM_MODEL,
        temperature: 0.2,
        max_tokens: 200,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: userMsg },
        ],
      }),
    });
    clearTimeout(t);

    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return res.status(200).json({ success: false, error: `provider ${r.status}`, detail: txt.slice(0, 200) });
    }

    const j = await r.json();
    const raw = (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    const out = parseVerdict(raw);
    return res.status(200).json({ success: true, ...out, model: LLM_MODEL });
  } catch (e) {
    return res.status(200).json({ success: false, error: String(e && e.message || e) });
  }
}

function parseVerdict(raw) {
  let level = 'MEDIUM', verdict = '';
  const cleaned = String(raw).replace(/```json|```/g, '').trim();
  try {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      const o = JSON.parse(m[0]);
      if (o.level) level = String(o.level).toUpperCase();
      if (o.verdict) verdict = String(o.verdict).trim();
    }
  } catch (e) {}
  if (!verdict) {
    verdict = cleaned.slice(0, 200) || 'Not enough signals for a confident read.';
    if (/high risk|likely rug|scam|avoid|dangerous/i.test(cleaned)) level = 'HIGH';
    else if (/low risk|looks clean|no obvious/i.test(cleaned)) level = 'LOW';
  }
  if (!['LOW', 'MEDIUM', 'HIGH'].includes(level)) level = 'MEDIUM';
  return { level, verdict };
}
