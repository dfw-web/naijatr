import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseConfig } from '../config/account'

/**
 * The Supabase client, loaded on demand: visitors who never sign in don't
 * download it. Sessions live in localStorage under STORAGE_KEY, so a signed-in
 * device is known at once, without loading anything.
 */

export const STORAGE_KEY = 'naijatr.auth'

let client: Promise<SupabaseClient> | null = null

export function getClient(): Promise<SupabaseClient> {
  client ??= import('@supabase/supabase-js').then(({ createClient }) => {
    const { url, key } = supabaseConfig()
    return createClient(url, key, {
      auth: {
        storageKey: STORAGE_KEY,
        persistSession: true,
        autoRefreshToken: true,
        // The email link's tokens are read by takeAuthRedirect (below), before the app's own hash routes see them.
        detectSessionInUrl: false,
        flowType: 'implicit',
      },
    })
  })
  return client
}

/** True if this device has a stored session (it may have expired; the client refreshes it). */
export function hasStoredSession(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null
  } catch {
    return false
  }
}

export interface AuthRedirect {
  accessToken?: string
  refreshToken?: string
  error?: string
}

/**
 * Back from the email link: https://www.naijatr.com/#access_token=…&refresh_token=…
 * (or #error_description=… for an expired link). Takes the tokens out of the
 * address straight away, so they're never shared or bookmarked.
 */
export function takeAuthRedirect(location: Location = window.location): AuthRedirect | null {
  const hash = location.hash.replace(/^#/, '')
  if (!/(^|&)(access_token|error_description)=/.test(hash)) return null
  const params = new URLSearchParams(hash)
  window.history.replaceState(window.history.state, '', location.pathname + location.search)
  const error = params.get('error_description')
  if (error) return { error: error.replace(/\+/g, ' ') }
  return { accessToken: params.get('access_token') ?? undefined, refreshToken: params.get('refresh_token') ?? undefined }
}

/** Test helper. */
export function resetClient(next: Promise<SupabaseClient> | null = null) {
  client = next
}
