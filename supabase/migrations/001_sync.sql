-- NAIJA TR: optional accounts that sync Continue Watching, My List and the
-- taste profile across devices (src/account). Run once in Supabase → SQL Editor.
-- Every table is keyed by the signed-in user and protected by Row Level
-- Security: a user can only read and change their own rows.

-- Continue Watching: one row per movie or series (a series row is the episode
-- the viewer is on), with the exact position.
create table if not exists public.continue_watching (
  user_id uuid not null references auth.users (id) on delete cascade,
  title_id text not null,                 -- our id, e.g. "tmdb-movie-550"
  tmdb_id integer,
  media_type text not null check (media_type in ('movie', 'tv')),
  season integer,
  episode integer,
  progress_seconds double precision,
  duration_seconds double precision,
  last_watched_at timestamptz not null default now(),
  title text not null default '',
  poster_path text,
  data jsonb not null default '{}'::jsonb, -- the rest of the card (episode name, seasons, source…)
  updated_at timestamptz not null default now(),
  primary key (user_id, title_id)
);
create index if not exists continue_watching_recent on public.continue_watching (user_id, last_watched_at desc);

-- My List: titles saved to watch later.
create table if not exists public.my_list (
  user_id uuid not null references auth.users (id) on delete cascade,
  title_id text not null,
  tmdb_id integer,
  media_type text not null check (media_type in ('movie', 'tv')),
  title text not null default '',
  poster_path text,
  saved_at timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb,
  primary key (user_id, title_id)
);

-- The personalised home's taste profile: one JSON document per user.
create table if not exists public.taste_profile (
  user_id uuid primary key references auth.users (id) on delete cascade,
  profile jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- The account's Telegram link, so contest and referral data stay connected.
create table if not exists public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  telegram_id bigint,
  telegram_username text,
  telegram_name text,
  referral_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.continue_watching enable row level security;
alter table public.my_list enable row level security;
alter table public.taste_profile enable row level security;
alter table public.profiles enable row level security;

-- Own rows only, for every table and every action.
do $$
declare
  t text;
begin
  foreach t in array array['continue_watching', 'my_list', 'taste_profile', 'profiles'] loop
    execute format('drop policy if exists "own rows: select" on public.%I', t);
    execute format('drop policy if exists "own rows: insert" on public.%I', t);
    execute format('drop policy if exists "own rows: update" on public.%I', t);
    execute format('drop policy if exists "own rows: delete" on public.%I', t);
    execute format('create policy "own rows: select" on public.%I for select to authenticated using ((select auth.uid()) = user_id)', t);
    execute format('create policy "own rows: insert" on public.%I for insert to authenticated with check ((select auth.uid()) = user_id)', t);
    execute format('create policy "own rows: update" on public.%I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)', t);
    execute format('create policy "own rows: delete" on public.%I for delete to authenticated using ((select auth.uid()) = user_id)', t);
  end loop;
end
$$;

grant select, insert, update, delete on public.continue_watching, public.my_list, public.taste_profile, public.profiles to authenticated;
revoke all on public.continue_watching, public.my_list, public.taste_profile, public.profiles from anon;
