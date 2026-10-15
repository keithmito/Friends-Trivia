// Preset-category questions from Open Trivia DB (free, no key needed).
import { buildQuestion } from '../js/game.js';

const DIFFICULTIES = new Set(['easy', 'medium', 'hard']);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchOpenTdb({ amount, category, difficulty }) {
  const url = new URL('https://opentdb.com/api.php');
  url.searchParams.set('amount', String(amount));
  url.searchParams.set('type', 'multiple');
  url.searchParams.set('encode', 'url3986');
  if (category) url.searchParams.set('category', category);
  if (difficulty) url.searchParams.set('difficulty', difficulty);
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`Open Trivia DB answered ${r.status}`);
  return r.json();
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const amount = Math.min(20, Math.max(3, parseInt(req.query.amount, 10) || 10));
  const category = /^\d{1,3}$/.test(String(req.query.category || '')) ? String(req.query.category) : '';
  let difficulty = DIFFICULTIES.has(req.query.difficulty) ? req.query.difficulty : '';

  try {
    let data = await fetchOpenTdb({ amount, category, difficulty });
    // 5 = rate limited (one request per 5 seconds per IP): wait and retry once.
    if (data.response_code === 5) {
      await wait(5200);
      data = await fetchOpenTdb({ amount, category, difficulty });
    }
    // 1 = not enough questions at that difficulty: retry with any difficulty.
    if (data.response_code === 1 && difficulty) {
      difficulty = '';
      await wait(5200);
      data = await fetchOpenTdb({ amount, category, difficulty });
    }
    if (data.response_code !== 0 || !Array.isArray(data.results)) {
      return res.status(502).json({ error: 'Open Trivia DB had no questions for that choice.' });
    }
    const dec = (s) => decodeURIComponent(String(s || ''));
    const questions = data.results
      .map((q) =>
        buildQuestion({
          question: dec(q.question),
          correct: dec(q.correct_answer),
          wrong: (q.incorrect_answers || []).map(dec),
          category: dec(q.category),
        })
      )
      .filter(Boolean);
    if (!questions.length) return res.status(502).json({ error: 'Open Trivia DB returned unusable questions.' });
    res.status(200).json({ questions, source: 'opentdb' });
  } catch (err) {
    res.status(502).json({ error: 'Could not reach Open Trivia DB.', detail: String(err.message || err) });
  }
}
