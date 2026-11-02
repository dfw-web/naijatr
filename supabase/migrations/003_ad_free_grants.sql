-- NAIJA TR: paid ad-free, given by hand from /admin/live → Give ad-free (server/referral).
-- Run once in Supabase → SQL Editor, after 002_referrals.sql. Safe to run again.
--
-- A log of every grant and removal. Only the server (service role key) reads
-- and writes it: Row Level Security is on with no policies, and signed-in
-- users and visitors have no access at all.

create table if not exists public.ad_free_grants (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users (id) on delete set null,
  email text not null,                   -- as it was when granted (kept if the account is deleted)
  action text not null default 'grant' check (action in ('grant', 'remove')),
  plan text,                             -- "1 Month", "3 Months", "Custom"
  days integer not null default 0,
  amount integer not null default 0,     -- naira paid (a refund on a removal is negative)
  note text,                             -- e.g. "paid ₦2,000 via PalmPay 2 Nov"
  ad_free_until timestamptz,             -- the account's end date after this change
  created_at timestamptz not null default now()
);
create index if not exists ad_free_grants_user on public.ad_free_grants (user_id, created_at desc);
create index if not exists ad_free_grants_created on public.ad_free_grants (created_at desc);

alter table public.ad_free_grants enable row level security;
revoke all on public.ad_free_grants from anon, authenticated;
