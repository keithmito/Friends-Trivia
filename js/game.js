// Pure game helpers shared by the browser and the /api functions.

// No I, L, O so codes are easy to read out loud.
export const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ';

export function makeCode(rand = Math.random) {
  let code = '';
  for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(rand() * CODE_CHARS.length)];
  return code;
}

export function cleanCode(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
}

export function shuffle(list, rand = Math.random) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Points: 500 for a correct answer, up to 500 more for speed,
// and +100 per answer in a row after the first (max +300).
export const MAX_STREAK_BONUS = 300;

export function scoreAnswer({ correct, elapsedMs, durationMs, streak = 0 }) {
  if (!correct) return { points: 0, streak: 0, bonus: 0 };
  const left = Math.max(0, Math.min(1, 1 - elapsedMs / durationMs));
  const newStreak = streak + 1;
  const bonus = Math.min((newStreak - 1) * 100, MAX_STREAK_BONUS);
  return { points: 500 + Math.round(500 * left) + bonus, streak: newStreak, bonus };
}

export function rankPlayers(players) {
  return Object.entries(players)
    .map(([id, p]) => ({ id, ...p }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

// Builds a question with the right answer shuffled in among three wrong ones.
// Returns null if the input isn't a usable four-option question.
export function buildQuestion({ question, correct, wrong, category = '', fact = '' }, rand = Math.random) {
  const text = String(question || '').trim();
  const right = String(correct || '').trim();
  if (!text || !right || !Array.isArray(wrong)) return null;
  const seen = new Set([right.toLowerCase()]);
  const others = [];
  for (const w of wrong) {
    const s = String(w || '').trim();
    if (s && !seen.has(s.toLowerCase())) {
      seen.add(s.toLowerCase());
      others.push(s);
    }
    if (others.length === 3) break;
  }
  if (others.length < 3) return null;
  const options = shuffle([right, ...others], rand);
  return {
    text: text.slice(0, 300),
    options: options.map((o) => o.slice(0, 120)),
    answer: options.indexOf(right),
    category: String(category || '').slice(0, 60),
    fact: String(fact || '').trim().slice(0, 240),
  };
}
