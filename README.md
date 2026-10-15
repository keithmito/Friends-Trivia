# Friends Trivia

Live trivia for you and your friends, played on your own phones.

- One person creates a room and gets a 4-letter code. Everyone else joins with the code or a WhatsApp link.
- Each question has a countdown. Faster correct answers score more, and answering several in a row earns a streak bonus.
- Pick from 16 ready-made categories, or **type any topic** ("Kenyan music hits", "Premier League legends"). Gemini then writes fresh questions on the spot.
- **Everyone picks:** each player types their own topic in the lobby, and the questions are mixed from all of them ("Wanjiru's pick: Formula 1").
- Answers are marked automatically, with a fun fact after each question, a live leaderboard, and a drumroll before the podium.
- Sounds and vibration: a ticking countdown in the last 5 seconds, right/wrong sounds, a drumroll and fanfare. A speaker button turns them off.
- **Season leaderboard:** every game with 2+ players is saved, ranked by wins and then points, for this month or all time.
- **Never freezes:** phones stay awake during a game. If the host drops out or their phone locks, another player takes over within about 10 seconds. If the host taps Leave, it happens instantly.
- **Rejoin:** if someone's network drops or they close the tab, opening the link again puts them straight back in with their score.
- **Protected AI quota:** see "How the Gemini quota is protected" below.

## How it works

| Part | What it does |
| --- | --- |
| `index.html`, `styles.css`, `js/` | The game itself (plain HTML/JS, no build step) |
| `api/config.js` | Gives the browser the public Supabase settings |
| `api/questions.js` | Gets preset-category questions from [Open Trivia DB](https://opentdb.com) (free, no key) |
| `api/generate.js` | Writes custom-topic questions with Google Gemini (key stays on the server) |
| `api/room.js` | Gives each new room a signed ticket |
| `api/results.js`, `api/leaderboard.js` | Save finished games and read the season table |
| `supabase/setup.sql` | One-time database setup for limits, the question cache and the leaderboard |
| Supabase Realtime | Connects everyone's phones in a room. No database tables needed. |

The host's phone runs the game: it keeps the questions and the scores, and tells everyone else what to show. It also sends a backup copy to the other phones every few seconds, so if the host disappears, the player next in line takes over from where things were. If the host was in the middle of a question, that question restarts.

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

### 3. Supabase database (quota protection + season leaderboard)
1. In Supabase, open **SQL Editor → New query**. Paste everything from [`supabase/setup.sql`](supabase/setup.sql) and press **Run**. It's safe to run again.
2. In **Settings → API Keys**, create or copy a **secret key** (starts with `sb_secret_`). Never share this one.
3. In Vercel, add it as an environment variable named `SUPABASE_SERVICE_ROLE_KEY`, then redeploy.

Without these two steps the game still works, but there are no usage limits and no season leaderboard.

### 4. Vercel (hosting)
1. At [vercel.com](https://vercel.com), choose **Add New → Project** and import this GitHub repo. Leave the framework preset as **Other**, with no build command.
2. Before deploying, add these **Environment Variables**:

   | Name | Value |
   | --- | --- |
   | `SUPABASE_URL` | your Project URL |
   | `SUPABASE_ANON_KEY` | your anon or publishable key |
   | `GEMINI_API_KEY` | your Gemini key |
   | `SUPABASE_SERVICE_ROLE_KEY` | your Supabase **secret** key (`sb_secret_…`) |

3. Click **Deploy**. Open the link on your phone, create a room, and share the code.

If you add or change a variable later, go to **Deployments → ⋯ → Redeploy** so the new value takes effect.

## How the Gemini quota is protected
1. **Same site only:** the question writer only answers requests made by pages on this site.
2. **Room tickets:** every room gets a ticket signed by the server, and questions can't be requested without one.
3. **Usage limits**, counted in Supabase: 6 custom-topic games per room per hour, 20 per network per day, and 150 for the whole site per day. Preset categories are never limited. To change the limits, set `ROOM_LIMIT_PER_HOUR`, `IP_LIMIT_PER_DAY` or `SITE_LIMIT_PER_DAY` in Vercel.
4. **Reuse:** questions for the same topics are saved for 14 days and reused in a fresh order, which costs no quota.

Also keep **billing off** on the Google project behind your Gemini key. Then the free tier is the absolute ceiling and you can never be charged.

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

## Testing
`npm test` runs the unit tests. The multiplayer behaviour (host takeover, rejoining, everyone-picks, final and season screens) was tested with three simulated phones in a headless browser.

## Ideas for next games
Sketch-and-guess, using the same rooms: one player draws, everyone else guesses in chat.
