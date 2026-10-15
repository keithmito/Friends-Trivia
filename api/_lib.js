// Shared server helpers. Files starting with "_" in /api are not public routes on Vercel.
import crypto from 'node:crypto';

export const env = (k, d = '') => process.env[k] || d;
const SUPABASE_URL = () => env('SUPABASE_URL').replace(/\/+$/, '');
const SERVICE_KEY = () => env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_SECRET_KEY');

export const hasDb = () => Boolean(SUPABASE_URL() && SERVICE_KEY());

// ---------- request helpers ----------
export function readBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  return body && typeof body === 'object' ? body : {};
}

export function clientIp(req) {
  const fwd = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || String(req.headers?.['x-real-ip'] || 'unknown');
}

// Only accept calls made by pages on this same site.
export function sameOrigin(req) {
  const origin = req.headers?.origin;
  const host = req.headers?.['x-forwarded-host'] || req.headers?.host;
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === String(host).split(',')[0].trim();
  } catch {
    return false;
  }
}

// ---------- signed game tickets ----------
// A ticket proves a room was created through the game. Format: base64url(payload).signature
const TICKET_HOURS = 12;

function ticketSecret() {
  const base = env('TICKET_SECRET') || SERVICE_KEY() || env('GEMINI_API_KEY');
  // Derive a separate key so the raw secret is never used directly.
  return crypto.createHmac('sha256', base || 'friends-trivia-dev').update('ticket-v1').digest();
}

export function signTicket(code, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ c: code, e: now + TICKET_HOURS * 3600e3 })).toString('base64url');
  const sig = crypto.createHmac('sha256', ticketSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyTicket(ticket, now = Date.now()) {
  const [payload, sig] = String(ticket || '').split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', ticketSecret()).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!/^[A-Z]{4}$/.test(data.c) || typeof data.e !== 'number' || data.e < now) return null;
    return { code: data.c, expires: data.e };
  } catch {
    return null;
  }
}

// ---------- Supabase (server only, secret key) ----------
export async function db(path, { method = 'GET', body, prefer } = {}) {
  const headers = { apikey: SERVICE_KEY(), 'content-type': 'application/json' };
  if (prefer) headers.prefer = prefer;
  const r = await fetch(`${SUPABASE_URL()}/rest/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const e = new Error(`Supabase ${r.status}: ${typeof data === 'string' ? data : data?.message || ''}`);
    e.status = r.status;
    throw e;
  }
  return data;
}

// Counts one use of `bucket`. Returns false once the limit for the window is reached.
export async function bump(bucket, limit, windowSeconds) {
  const ok = await db('rpc/bump_usage', {
    method: 'POST',
    body: { p_bucket: bucket, p_limit: limit, p_window_seconds: windowSeconds },
  });
  return ok === true;
}

export const limitNum = (k, d) => {
  const n = parseInt(env(k), 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export const today = (now = new Date()) => now.toISOString().slice(0, 10);

export function hashKey(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 40);
}
