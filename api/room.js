// Issues a signed game ticket for a new room. The ticket is required to generate AI questions
// and to save results, so the generator can't be called without going through the game.
import { readBody, sameOrigin, signTicket, hasDb, bump, clientIp, hashKey, limitNum, today } from './_lib.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });
  if (!sameOrigin(req)) return res.status(403).json({ error: 'Rooms can only be created from the game itself.' });

  const code = String(readBody(req).code || '').toUpperCase();
  if (!/^[A-Z]{4}$/.test(code)) return res.status(400).json({ error: 'Bad room code.' });

  if (hasDb()) {
    try {
      const ok = await bump(`rooms:ip:${hashKey(clientIp(req))}:${today()}`, limitNum('ROOMS_PER_IP_PER_DAY', 60), 86400);
      if (!ok) return res.status(429).json({ error: 'Too many rooms created from this network today. Try again tomorrow.' });
    } catch {
      // If the counter is unavailable, still let people play.
    }
  }
  res.status(200).json({ ticket: signTicket(code) });
}
