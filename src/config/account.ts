/**
 * Optional accounts (src/account): sign in with an email link to sync Continue
 * Watching, My List and the taste profile across devices. Never needed to
 * browse or watch. Off (no "Sign in" anywhere) while the Supabase project's
 * URL or publishable key is missing. Both are public: they're in the page.
 */
export const supabaseConfig = () => ({
  url: (import.meta.env.VITE_SUPABASE_URL ?? '').trim(),
  key: (import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim(),
})

export const accountsEnabled = () => {
  const { url, key } = supabaseConfig()
  return url !== '' && key !== ''
}

/** "Continue with Google": off until Google is set up in Supabase → Authentication → Providers. */
export const GOOGLE_LOGIN_ENABLED = false

/** While watching, progress goes up at most this often (plus on pause, close and leaving the page). */
export const SYNC_INTERVAL_MS = 15_000

/** After a failed sync, the next try waits this long. */
export const SYNC_RETRY_MS = 60_000

/** "Sign in to keep your progress": after this many titles watched (or one saved), at most once a week. */
export const SYNC_PROMPT = { titlesWatched: 2, snoozeMs: 7 * 24 * 60 * 60 * 1000 }
