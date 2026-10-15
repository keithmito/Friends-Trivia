import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCode, cleanCode, scoreAnswer, buildQuestion, rankPlayers, CODE_CHARS } from '../js/game.js';
import generate from '../api/generate.js';
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

test('generate: parses Gemini output and falls back between models', async () => {
  process.env.GEMINI_API_KEY = 'k';
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(url);
    if (calls.length === 1) return { ok: false, status: 404, json: async () => ({ error: { message: 'model not found' } }) };
    const payload = { questions: [
      { question: 'Q1?', correct: 'A', wrong: ['B', 'C', 'D'], fact: 'f1' },
      { question: 'Q2?', correct: 'E', wrong: ['F', 'G', 'H'], fact: 'f2' },
      { question: 'Q3?', correct: 'I', wrong: ['J', 'K', 'L'], fact: 'f3' },
      { question: 'bad', correct: 'X', wrong: ['X'] },
    ] };
    assert.equal(opts.headers['x-goog-api-key'], 'k');
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }) };
  };
  const res = mockRes();
  await generate({ method: 'POST', body: { topic: 'Kenyan music', amount: 3, difficulty: 'easy' } }, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.questions.length, 3);
  assert.equal(res.body.questions[0].category, 'Kenyan music');
  assert.equal(calls.length, 2);
});

test('generate: rejects empty topic and missing key', async () => {
  let res = mockRes();
  await generate({ method: 'POST', body: { topic: ' ' } }, res);
  assert.equal(res.code, 400);
  delete process.env.GEMINI_API_KEY;
  res = mockRes();
  await generate({ method: 'POST', body: { topic: 'x y' } }, res);
  assert.equal(res.code, 503);
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
