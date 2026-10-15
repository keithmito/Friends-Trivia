# Friends Trivia

Live trivia for you and your friends, played on your own phones.

- One person creates a room and gets a 4-letter code. Everyone else joins with the code or a WhatsApp link.
- Each question has a countdown. Faster correct answers score more, and answering several in a row earns a streak bonus.
- Pick from 16 ready-made categories, or **type any topic** ("Kenyan music hits", "Premier League legends"). Gemini then writes fresh questions on the spot.
- Answers are marked automatically, with a fun fact after each question, a live leaderboard, and a podium at the end.

## How it works

| Part | What it does |
| --- | --- |
| `index.html`, `styles.css`, `js/` | The game itself (plain HTML/JS, no build step) |
| `api/config.js` | Gives the browser the public Supabase settings |
| `api/questions.js` | Gets preset-category questions from [Open Trivia DB](https://opentdb.com) (free, no key) |
| `api/generate.js` | Writes custom-topic questions with Google Gemini (key stays on the server) |
| Supabase Realtime | Connects everyone's phones in a room. No database tables needed. |

The host's phone runs the game: it keeps the questions and the scores, and tells everyone else what to show. **The host should keep the game open on screen while playing**, because phones pause background tabs. If the host refreshes, the game picks up where it left off.

## Setup (about 10 minutes, all free)

### 1. Supabase (live rooms)
1. Sign up at [supabase.com](https://supabase.com) and create a new project. Any name and region works; pick one near Nairobi for speed.
2. Open **Project Settings → API Keys** (sometimes listed under **Data API**). Copy:
   - the **Project URL** (looks like `https://abcd1234.supabase.co`)
   - the **anon** key, or the **publishable** key (starts with `sb_publishable_`)
3. Open **Realtime → Settings** and make sure public channels are allowed. In other words, "Private channels only" must be **off**.

### 2. Gemini (custom topics)
1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey) and create an API key. The free tier is plenty for games with friends.
2. Optional: questions come from `gemini-3.8-flash`, falling back to `gemini-3.5-flash-lite`. If Google renames its models later, set `GEMINI_MODEL` to a current model name.

### 3. Vercel (hosting)
1. At [vercel.com](https://vercel.com), choose **Add New → Project** and import this GitHub repo. Leave the framework preset as **Other**, with no build command.
2. Before deploying, add these **Environment Variables**:

   | Name | Value |
   | --- | --- |
   | `SUPABASE_URL` | your Project URL |
   | `SUPABASE_ANON_KEY` | your anon or publishable key |
   | `GEMINI_API_KEY` | your Gemini key |

3. Click **Deploy**. Open the link on your phone, create a room, and share the code.

If you add or change a variable later, go to **Deployments → ⋯ → Redeploy** so the new value takes effect.

## Playing tips
- 3–10 players works best. Big groups are fine too.
- For custom topics, the more specific the description, the better the questions ("Kenyan hip-hop 2005–2015" beats "music").
- The host can press **Show answer now** to skip waiting for someone who has stepped away.
- Open Trivia DB allows one request every 5 seconds. If Start fails, wait a moment and press it again. When a Gemini key is set, the game falls back to Gemini automatically.

## Running locally
```bash
npm i -g vercel
vercel dev          # uses a .env file; see .env.example
npm test            # unit tests for scoring and the API functions
```

## Ideas for next games
Sketch-and-guess, using the same rooms: one player draws, everyone else guesses in chat.
