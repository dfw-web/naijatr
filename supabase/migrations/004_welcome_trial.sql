-- NAIJA TR: the 48-hour Premium welcome trial (server/trial.ts).
-- Run once in Supabase → SQL Editor, after 003_ad_free_grants.sql. Safe to run again.
--
-- Written by the server only (service role key). Signed-in users can read
-- their own profile row, and can't change any of this.

-- ---- profiles: the trial's end, and how the account signed up ----
alter table public.profiles add column if not exists welcome_trial_until timestamptz;
alter table public.profiles add column if not exists signup_source text;
create index if not exists profiles_welcome_trial on public.profiles (welcome_trial_until) where welcome_trial_until is not null;
create index if not exists profiles_signup_source on public.profiles (signup_source, created_at) where signup_source is not null;

-- ---- One inbox, one address (as the server's normalizeEmail): lower case; Gmail without dots or a +tag ----
create or replace function public.normalize_email(email text) returns text
language sql immutable as $$
  select case
    when split_part(lower(trim(email)), '@', 2) in ('gmail.com', 'googlemail.com')
      then replace(split_part(split_part(lower(trim(email)), '@', 1), '+', 1), '.', '') || '@gmail.com'
    else lower(trim(email))
  end
$$;

-- ---- known_emails: every inbox that has ever had an account here ----
-- No foreign key: a row stays after the account is deleted, so signing up
-- again with the same inbox (or a Gmail dot / +tag variant) isn't "new".
create table if not exists public.known_emails (
  email_normalized text primary key,
  first_user_id uuid,
  first_seen_at timestamptz not null default now()
);

-- Every account there is today, oldest first (its first account keeps the inbox).
insert into public.known_emails (email_normalized, first_user_id, first_seen_at)
select distinct on (public.normalize_email(email)) public.normalize_email(email), id, created_at
from auth.users
where email is not null and email <> ''
order by public.normalize_email(email), created_at
on conflict (email_normalized) do nothing;

-- And every new one, the moment it's made. Never blocks a sign-up.
create or replace function public.remember_email() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.email is not null and new.email <> '' then
    insert into public.known_emails (email_normalized, first_user_id)
    values (public.normalize_email(new.email), new.id)
    on conflict (email_normalized) do nothing;
  end if;
  return new;
exception when others then
  return new;
end
$$;

drop trigger if exists remember_email on auth.users;
create trigger remember_email after insert or update of email on auth.users
  for each row execute function public.remember_email();

-- ---- welcome_trials: one per inbox, ever (kept after the account is deleted) ----
create table if not exists public.welcome_trials (
  email_normalized text primary key,
  user_id uuid,
  device_hash text,                      -- salted hash of the device's id, never the id
  source text,                           -- how the account signed up, e.g. play-popup
  started_at timestamptz not null,
  until timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists welcome_trials_device on public.welcome_trials (device_hash) where device_hash is not null;
create index if not exists welcome_trials_created on public.welcome_trials (created_at);
create index if not exists welcome_trials_until on public.welcome_trials (until);

alter table public.known_emails enable row level security;
alter table public.welcome_trials enable row level security;
revoke all on public.known_emails, public.welcome_trials from anon, authenticated;
