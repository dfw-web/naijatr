-- NAIJA TR: account-based referrals and the ad-free reward (server/referral).
-- Run once in Supabase → SQL Editor, after 001_sync.sql. Safe to run again.
--
-- Everything here is written by the server only (/api/referral/*, with the
-- service role key). Signed-in users can read their own rows, and can't
-- change their ad-free date, invite code or reward count.

-- ---- profiles: the invite code and the ad-free reward ----
alter table public.profiles add column if not exists invite_code text;
alter table public.profiles add column if not exists ad_free_until timestamptz;
alter table public.profiles add column if not exists rewards_granted integer not null default 0;
alter table public.profiles add column if not exists email_normalized text;
alter table public.profiles add column if not exists last_ip_hash text;

create unique index if not exists profiles_invite_code on public.profiles (invite_code);
create index if not exists profiles_email_normalized on public.profiles (email_normalized);

-- 001 let users write any column of their own profile. From now on they may
-- only write the Telegram link columns; the reward columns are server-only.
revoke insert, update on public.profiles from authenticated;
grant insert (user_id, telegram_id, telegram_username, telegram_name, referral_code, created_at, updated_at) on public.profiles to authenticated;
grant update (telegram_id, telegram_username, telegram_name, referral_code, updated_at) on public.profiles to authenticated;

-- ---- referrals: one row per invited account ----
create table if not exists public.referrals (
  id bigint generated always as identity primary key,
  referrer_id uuid not null references auth.users (id) on delete cascade,
  referred_user_id uuid not null unique references auth.users (id) on delete cascade,
  -- pending: signed up, not counted yet; counted; held: over the daily per-network limit
  -- (left for review); rejected: self-referral or an inbox that already has an account.
  status text not null default 'pending' check (status in ('pending', 'counted', 'held', 'rejected')),
  reason text,
  flags text[] not null default '{}',
  ip_hash text,                          -- salted hash, never the IP
  created_at timestamptz not null default now(),
  counted_at timestamptz
);
create index if not exists referrals_referrer on public.referrals (referrer_id, status);
create index if not exists referrals_counted on public.referrals (counted_at) where status = 'counted';
create index if not exists referrals_ip on public.referrals (ip_hash, counted_at);

alter table public.referrals enable row level security;
drop policy if exists "own referrals: select" on public.referrals;
create policy "own referrals: select" on public.referrals for select to authenticated
  using ((select auth.uid()) = referrer_id or (select auth.uid()) = referred_user_id);
revoke all on public.referrals from anon, authenticated;
grant select on public.referrals to authenticated;

-- ---- weekly mystery prize: the admin's decisions (/admin/referrals) ----
create table if not exists public.referral_weeks (
  week_start date not null,              -- Monday, Lagos time
  user_id uuid not null references auth.users (id) on delete cascade,
  decision text not null check (decision in ('winner', 'disqualified')),
  referrals integer not null default 0,
  decided_at timestamptz not null default now(),
  primary key (week_start, user_id)
);
create unique index if not exists referral_weeks_one_winner on public.referral_weeks (week_start) where decision = 'winner';

alter table public.referral_weeks enable row level security;
drop policy if exists "own weeks: select" on public.referral_weeks;
create policy "own weeks: select" on public.referral_weeks for select to authenticated
  using ((select auth.uid()) = user_id);
revoke all on public.referral_weeks from anon, authenticated;
grant select on public.referral_weeks to authenticated;
