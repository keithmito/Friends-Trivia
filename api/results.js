// Saves a finished game to the season leaderboard. Called once by the host's phone at the final screen.
import { readBody, sameOrigin, verifyTicket, hasDb, db, bump } from './_lib.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });
  if (!hasDb()) return res.status(503).json({ error: 'The season leaderboard is not set up yet.' });
  if (!sameOrigin(req)) return res.status(403).json({ error: 'Results can only be saved from the game itself.' });

  const body = readBody(req);
  const ticket = verifyTicket(body.ticket);
  if (!ticket) return res.status(401).json({ error: 'This room has expired.' });

  const gameId = String(body.gameId || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40);
  if (gameId.length < 8) return res.status(400).json({ error: 'Missing game id.' });

  // One entry per name, real names only, sane scores.
  const seen = new Set();
  const players = [];
  for (const p of Array.isArray(body.players) ? body.players : []) {
    const name = String(p?.name || '').replace(/\s+/g, ' ').trim().slice(0, 16);
    const key = name.toLowerCase();
    const score = Math.max(0, Math.min(40000, parseInt(p?.score, 10) || 0));
    if (name && !seen.has(key)) {
      seen.add(key);
      players.push({ name, key, score });
    }
    if (players.length === 30) break;
  }
  if (players.length < 2) return res.status(200).json({ saved: false, reason: 'Games need at least 2 players to count.' });

  try {
    if (!(await bump(`results:room:${ticket.code}`, 30, 86400))) {
      return res.status(429).json({ error: 'Too many games saved from this room today.' });
    }
    const top = Math.max(...players.map((p) => p.score));
    const sorted = [...players].sort((a, b) => b.score - a.score);
    const rows = sorted.map((p) => ({
      room: ticket.code,
      game_id: gameId,
      player_name: p.name,
      name_key: p.key,
      score: p.score,
      rank: 1 + sorted.filter((o) => o.score > p.score).length,
      won: top > 0 && p.score === top,
      players: players.length,
    }));
    await db('game_results?on_conflict=game_id,name_key', {
      method: 'POST',
      prefer: 'resolution=ignore-duplicates,return=minimal',
      body: rows,
    });
    res.status(200).json({ saved: true });
  } catch (err) {
    res.status(502).json({ error: 'Could not save to the leaderboard.', detail: err.message });
  }
}
