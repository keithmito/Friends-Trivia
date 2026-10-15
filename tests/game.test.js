import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCode, cleanCode, scoreAnswer, buildQuestion, rankPlayers, CODE_CHARS } from '../js/game.js';
import generate from '../api/generate.js';
import results from '../api/results.js';
import { signTicket, verifyTicket, sameOrigin } from '../api/_lib.js';
import questions from '../api/questions.js';

const mockRes = () => {
  const r = { code: 0, body: null, headers: {} };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
};

test('room codes are 4 readable letters', () => {
  for (let i = 0; i < 200; i++) {
    const c = makeCode();
    assert.equal(c.length, 4);
    for (const ch of c) assert.ok(CODE_CHARS.includes(ch));
  }
  assert.equal(cleanCode(' ab-cd9e '), 'ABCD');
});

test('scoring rewards speed and streaks', () => {
  assert.deepEqual(scoreAnswer({ correct: false, elapsedMs: 0, durationMs: 20000, streak: 3 }), { points: 0, streak: 0, bonus: 0 });
  assert.equal(scoreAnswer({ correct: true, elapsedMs: 0, durationMs: 20000 }).points, 1000);
  assert.equal(scoreAnswer({ correct: true, elapsedMs: 20000, durationMs: 20000 }).points, 500);
  assert.equal(scoreAnswer({ correct: true, elapsedMs: 10000, durationMs: 20000, streak: 1 }).points, 850);
  assert.equal(scoreAnswer({ correct: true, elapsedMs: 30000, durationMs: 20000, streak: 9 }).points, 800);
});

test('buildQuestion shuffles and validates', () => {
  for (let i = 0; i < 50; i++) {
    const q = buildQuestion({ question: 'Capital of Kenya?', correct: 'Nairobi', wrong: ['Mombasa', 'Kisumu', 'Nakuru'] });
    assert.equal(q.options[q.answer], 'Nairobi');
    assert.equal(q.options.length, 4);
  }
  assert.equal(buildQuestion({ question: 'x', correct: 'A', wrong: ['a', 'B', 'C'] }), null);
  assert.equal(buildQuestion({ question: '', correct: 'A', wrong: ['B', 'C', 'D'] }), null);
});

test('ranking sorts by score', () => {
  const r = rankPlayers({ a: { name: 'Zed', score: 10 }, b: { name: 'Amy', score: 30 }, c: { name: 'Bo', score: 10 } });
  assert.deepEqual(r.map((p) => p.id), ['b', 'c', 'a']);
});

const req = (body, extra = {}) => ({ method: 'POST', body, headers: { origin: 'https://site.vercel.app', host: 'site.vercel.app', 'x-forwarded-for': '1.2.3.4' }, ...extra });
const geminiReply = (qs) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ questions: qs }) }] } }] }) });

test('tickets: sign, verify, reject tampering and expiry', () => {
  const t = signTicket('ABCD');
  assert.equal(verifyTicket(t).code, 'ABCD');
  assert.equal(verifyTicket(t.slice(0, -2) + 'xx'), null);
  const [p, sig] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ c: 'ZZZZ', e: Date.now() + 1e9 })).toString('base64url');
  assert.equal(verifyTicket(`${forged}.${sig}`), null);
  assert.equal(verifyTicket(t, Date.now() + 13 * 3600e3), null);
  assert.equal(verifyTicket('garbage'), null);
});

test('origin check', () => {
  assert.equal(sameOrigin({ headers: { origin: 'https://a.vercel.app', host: 'a.vercel.app' } }), true);
  assert.equal(sameOrigin({ headers: { origin: 'https://evil.com', host: 'a.vercel.app' } }), false);
  assert.equal(sameOrigin({ headers: { host: 'a.vercel.app' } }), false);
});

test('generate: blocks calls without origin or ticket', async () => {
  process.env.GEMINI_API_KEY = 'k';
  globalThis.fetch = async () => { throw new Error('must not call out'); };
  let res = mockRes();
  await generate({ method: 'POST', body: { topic: 'x y', ticket: signTicket('ABCD') }, headers: { host: 'site.vercel.app' } }, res);
  assert.equal(res.code, 403);
  res = mockRes();
  await generate(req({ topic: 'Kenyan music' }), res);
  assert.equal(res.code, 401);
});

test('generate: multiple topics, model fallback, labels by topic', async () => {
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.GEMINI_API_KEY = 'k';
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(String(url));
    if (calls.length === 1) return { ok: false, status: 404, json: async () => ({ error: { message: 'model not found' } }) };
    assert.equal(opts.headers['x-goog-api-key'], 'k');
    const prompt = JSON.parse(opts.body).contents[0].parts[0].text;
    assert.match(prompt, /0: "Afrobeats"/);
    assert.match(prompt, /1: "Formula 1"/);
    return geminiReply([
      { topic: 0, question: 'Q1?', correct: 'A', wrong: ['B', 'C', 'D'], fact: 'f1' },
      { topic: 1, question: 'Q2?', correct: 'E', wrong: ['F', 'G', 'H'], fact: 'f2' },
      { topic: 0, question: 'Q3?', correct: 'I', wrong: ['J', 'K', 'L'], fact: 'f3' },
      { topic: 1, question: 'bad', correct: 'X', wrong: ['X'] },
    ]);
  };
  const res = mockRes();
  await generate(req({ topics: ['Formula 1', 'Afrobeats', 'afrobeats'], amount: 3, difficulty: 'easy', ticket: signTicket('ABCD') }), res);
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal(res.body.questions.length, 3);
  assert.deepEqual(new Set(res.body.questions.map((q) => q.category)), new Set(['Afrobeats', 'Formula 1']));
  assert.equal(calls.length, 2);
});

test('generate: usage limits stop Gemini calls, cache hits skip them', async () => {
  process.env.GEMINI_API_KEY = 'k';
  process.env.SUPABASE_URL = 'https://db.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_x';
  let cacheItems = null;
  let cacheKey = null;
  let bumps = 0;
  let geminiCalls = 0;
  globalThis.fetch = async (url, opts = {}) => {
    url = String(url);
    if (url.startsWith('https://db.supabase.co/rest/v1/topic_cache?cache_key=eq.')) {
      assert.equal(opts.headers.apikey, 'sb_secret_x');
      assert.equal(opts.headers.authorization, undefined);
      const hit = cacheItems && url.includes(`cache_key=eq.${cacheKey}&`);
      return { ok: true, text: async () => JSON.stringify(hit ? [{ items: cacheItems }] : []) };
    }
    if (url.endsWith('/rpc/bump_usage')) {
      bumps += 1;
      const b = JSON.parse(opts.body);
      return { ok: true, text: async () => JSON.stringify(!(b.p_bucket.startsWith('gen:room:') && bumps > 2)) };
    }
    if (url.includes('topic_cache?on_conflict')) {
      ({ items: cacheItems, cache_key: cacheKey } = JSON.parse(opts.body));
      return { ok: true, text: async () => '' };
    }
    if (url.includes('generativelanguage')) {
      geminiCalls += 1;
      return geminiReply(Array.from({ length: 8 }, (_, i) => ({ topic: 0, question: `Q${i}?`, correct: `R${i}`, wrong: [`a${i}`, `b${i}`, `c${i}`], fact: '' })));
    }
    throw new Error('unexpected ' + url);
  };
  const ticket = signTicket('WXYZ');
  let res = mockRes();
  await generate(req({ topic: 'Kenyan music', amount: 3, ticket }), res);
  assert.equal(res.code, 200);
  assert.equal(res.body.source, 'gemini');
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(cacheItems && cacheItems.length === 8);
  // Same topic again: served from cache, no limit bump, no Gemini call.
  const b0 = bumps;
  res = mockRes();
  await generate(req({ topic: 'kenyan  MUSIC', amount: 5, ticket }), res);
  assert.equal(res.body.source, 'cache');
  assert.equal(res.body.questions.length, 5);
  assert.equal(bumps, b0);
  assert.equal(geminiCalls, 1);
  // New topic after the room limit is used: rejected before calling Gemini.
  res = mockRes();
  await generate(req({ topic: 'Formula 1', amount: 3, ticket }), res);
  assert.equal(res.code, 429);
  assert.equal(res.body.limited, true);
  assert.equal(geminiCalls, 1);
});

test('results: saves ranked rows once, needs 2+ players', async () => {
  const posted = [];
  globalThis.fetch = async (url, opts = {}) => {
    url = String(url);
    if (url.endsWith('/rpc/bump_usage')) return { ok: true, text: async () => 'true' };
    if (url.includes('game_results')) { posted.push(JSON.parse(opts.body)); return { ok: true, text: async () => '' }; }
    throw new Error(url);
  };
  const ticket = signTicket('WXYZ');
  let res = mockRes();
  await results(req({ ticket, gameId: 'game-123456', players: [{ name: 'Keith', score: 900 }] }), res);
  assert.equal(res.body.saved, false);
  res = mockRes();
  await results(req({ ticket, gameId: 'game-123456', players: [{ name: 'Keith', score: 900 }, { name: 'Wanjiru', score: 1200 }, { name: 'keith', score: 50 }, { name: 'Otieno', score: 1200 }] }), res);
  assert.equal(res.body.saved, true);
  const rows = posted[0];
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => [r.player_name, r.rank, r.won]), [['Wanjiru', 1, true], ['Otieno', 1, true], ['Keith', 3, false]]);
});

test('questions: decodes Open Trivia DB results', async () => {
  globalThis.fetch = async (url) => {
    assert.match(String(url), /category=22/);
    return { ok: true, json: async () => ({ response_code: 0, results: [
      { category: 'Geography', question: encodeURIComponent('Where is "Lake Turkana"?'), correct_answer: 'Kenya', incorrect_answers: ['Chad', 'Mali', 'Peru'] },
    ] }) };
  };
  const res = mockRes();
  await questions({ query: { amount: '5', category: '22', difficulty: 'easy' } }, res);
  assert.equal(res.code, 200);
  const q = res.body.questions[0];
  assert.equal(q.text, 'Where is "Lake Turkana"?');
  assert.equal(q.options[q.answer], 'Kenya');
});
