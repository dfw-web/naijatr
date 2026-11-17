-- NAIJA TR: where the viewer stopped in a short drama, for "Continue Ep 12 · 3:45"
-- on another device (src/dramas/history.ts, src/account/backend.ts).
-- Run once in Supabase → SQL Editor, after 005_drama_history.sql. Safe to run again.
--
-- Until this runs, short dramas still sync (episode number included), just
-- without the episode's id and the minute/second; each device keeps its own.

alter table public.drama_history add column if not exists episode_id text;
alter table public.drama_history add column if not exists position_s double precision;
alter table public.drama_history add column if not exists duration_s double precision;

alter table public.drama_history drop constraint if exists drama_history_progress_check;
alter table public.drama_history add constraint drama_history_progress_check check (
  (episode_id is null or char_length(episode_id) <= 60)
  and (position_s is null or (position_s >= 0 and position_s < 86400))
  and (duration_s is null or (duration_s >= 0 and duration_s < 86400))
);

-- PostgREST picks up the new columns now, not at its next schema refresh.
notify pgrst, 'reload schema';
