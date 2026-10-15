-- Friends Trivia: one-time setup.
-- Paste all of this into Supabase → SQL Editor → New query, then press Run.
-- Safe to run again; it won't delete anything.

-- Counters for usage limits (protects the Gemini quota)
create table if not exists public.api_usage (
  bucket text primary key,
  count integer not null default 0,
  expires_at timestamptz not null
);

-- Recently generated questions, reused for repeat topics
create table if not exists public.topic_cache (
  cache_key text primary key,
  items jsonb not null,
  created_at timestamptz not null default now()
);

-- One row per player per finished game (season leaderboard)
create table if not exists public.game_results (
  id bigint generated always as identity primary key,
  played_at timestamptz not null default now(),
  room text not null,
  game_id text not null,
  player_name text not null,
  name_key text not null,
  score integer not null,
  rank integer not null,
  won boolean not null,
  players integer not null,
  unique (game_id, name_key)
);
create index if not exists game_results_played_at on public.game_results (played_at);

-- Lock the tables: with RLS on and no policies, only the server (secret key) can use them.
alter table public.api_usage enable row level security;
alter table public.topic_cache enable row level security;
alter table public.game_results enable row level security;

-- Adds one use to a bucket; returns false once the limit for the window is reached.
create or replace function public.bump_usage(p_bucket text, p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  c integer;
begin
  insert into public.api_usage as u (bucket, count, expires_at)
  values (p_bucket, 1, now() + make_interval(secs => p_window_seconds))
  on conflict (bucket) do update set
    count = case when u.expires_at < now() then 1 else u.count + 1 end,
    expires_at = case when u.expires_at < now() then now() + make_interval(secs => p_window_seconds) else u.expires_at end
  returning u.count into c;

  -- Tidy up old counters now and then.
  if random() < 0.02 then
    delete from public.api_usage where expires_at < now() - interval '1 day';
  end if;

  return c <= p_limit;
end;
$$;

-- Season table: wins first, then total points.
create or replace function public.season_leaderboard(p_since timestamptz)
returns table (player_name text, games bigint, wins bigint, points bigint, best integer)
language sql
stable
security definer
set search_path = public
as $$
  select
    (array_agg(r.player_name order by r.played_at desc))[1] as player_name,
    count(*) as games,
    count(*) filter (where r.won) as wins,
    sum(r.score)::bigint as points,
    max(r.score) as best
  from public.game_results r
  where r.played_at >= p_since
  group by r.name_key
  order by wins desc, points desc
  limit 50;
$$;

-- Only the server may call these.
revoke all on function public.bump_usage(text, integer, integer) from public, anon, authenticated;
revoke all on function public.season_leaderboard(timestamptz) from public, anon, authenticated;
grant execute on function public.bump_usage(text, integer, integer) to service_role;
grant execute on function public.season_leaderboard(timestamptz) to service_role;
grant all on public.api_usage, public.topic_cache, public.game_results to service_role;
