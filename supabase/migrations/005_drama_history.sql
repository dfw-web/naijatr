-- NAIJA TR: "Your short dramas" on the home page (src/dramas/history.ts), synced
-- for signed-in users like Continue Watching (src/account/sync.ts).
-- Run once in Supabase → SQL Editor, after 001_sync.sql. Safe to run again.
--
-- Until this runs, signed-in users keep their short dramas on each device
-- (the app syncs everything else as usual and sends them once it exists).

create table if not exists public.drama_history (
  user_id uuid not null references auth.users (id) on delete cascade,
  entry_id text not null,                  -- "{provider}:{drama id}", e.g. "dramabox:42000023802"
  provider text not null,                  -- "dramabox", "dramawave", "netshort"…
  drama_id text not null,
  title text not null default '',
  poster text,
  episode integer check (episode is null or episode > 0),             -- "I'm on episode __"
  episode_count integer check (episode_count is null or episode_count > 0),
  viewed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, entry_id),
  check (char_length(entry_id) <= 120 and char_length(title) <= 300 and char_length(coalesce(poster, '')) <= 1000)
);
create index if not exists drama_history_recent on public.drama_history (user_id, viewed_at desc);

alter table public.drama_history enable row level security;

-- Own rows only, for every action.
drop policy if exists "own rows: select" on public.drama_history;
drop policy if exists "own rows: insert" on public.drama_history;
drop policy if exists "own rows: update" on public.drama_history;
drop policy if exists "own rows: delete" on public.drama_history;
create policy "own rows: select" on public.drama_history for select to authenticated using ((select auth.uid()) = user_id);
create policy "own rows: insert" on public.drama_history for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own rows: update" on public.drama_history for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own rows: delete" on public.drama_history for delete to authenticated using ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.drama_history to authenticated;
revoke all on public.drama_history from anon;
