// Season leaderboard: wins and points across game nights.
import { hasDb, db } from './_lib.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!hasDb()) return res.status(503).json({ error: 'The season leaderboard is not set up yet.' });

  const period = req.query?.period === 'all' ? 'all' : 'month';
  const now = new Date();
  const since = period === 'all'
    ? '2000-01-01T00:00:00Z'
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  try {
    const rows = await db('rpc/season_leaderboard', { method: 'POST', body: { p_since: since } });
    res.status(200).json({ period, since, players: Array.isArray(rows) ? rows : [] });
  } catch (err) {
    res.status(502).json({ error: 'Could not load the leaderboard. Has the setup SQL been run in Supabase?', detail: err.message });
  }
}
