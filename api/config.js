// Hands the browser the public Supabase settings.
// The Supabase anon/publishable key is designed to be public; the secret and Gemini keys are never sent.
import { hasDb } from './_lib.js';

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseKey: process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '',
    aiEnabled: Boolean(process.env.GEMINI_API_KEY),
    leaderboardEnabled: hasDb(),
  });
}
