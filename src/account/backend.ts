import type { SupabaseClient } from '@supabase/supabase-js'
import { isTasteProfile, type ContinueRow, type ListRow } from './merge'
import type { SyncBackend } from './sync'

const CONTINUE_COLUMNS =
  'user_id,title_id,tmdb_id,media_type,season,episode,progress_seconds,duration_seconds,last_watched_at,title,poster_path,data'
const LIST_COLUMNS = 'user_id,title_id,tmdb_id,media_type,title,poster_path,saved_at,data'

/** Throws on an error, so sync treats it as a failed try. */
const ok = <T>({ data, error }: { data: T; error: unknown }): T => {
  if (error) throw error
  return data
}

/**
 * The account's tables in Supabase (supabase/migrations/001_sync.sql). Row
 * Level Security lets each user reach only their own rows; user_id is still
 * named in every query so nothing else is ever asked for.
 */
export function supabaseBackend(client: SupabaseClient, userId: string): SyncBackend {
  const now = () => new Date().toISOString()
  return {
    async pull() {
      const [cw, list, taste] = await Promise.all([
        client.from('continue_watching').select(CONTINUE_COLUMNS).eq('user_id', userId).limit(100),
        client.from('my_list').select(LIST_COLUMNS).eq('user_id', userId).limit(200),
        client.from('taste_profile').select('profile').eq('user_id', userId).maybeSingle(),
      ])
      const profile = (ok(taste) as { profile?: unknown } | null)?.profile
      return {
        continueRows: (ok(cw) ?? []) as ContinueRow[],
        listRows: (ok(list) ?? []) as ListRow[],
        taste: isTasteProfile(profile) ? profile : null,
      }
    },
    async upsertContinue(rows) {
      ok(await client.from('continue_watching').upsert(rows.map((row) => ({ ...row, updated_at: now() })), { onConflict: 'user_id,title_id' }))
    },
    async deleteContinue(ids) {
      ok(await client.from('continue_watching').delete().eq('user_id', userId).in('title_id', ids))
    },
    async upsertList(rows) {
      ok(await client.from('my_list').upsert(rows, { onConflict: 'user_id,title_id' }))
    },
    async deleteList(ids) {
      ok(await client.from('my_list').delete().eq('user_id', userId).in('title_id', ids))
    },
    async saveTaste(profile) {
      ok(await client.from('taste_profile').upsert({ user_id: userId, profile, updated_at: now() }, { onConflict: 'user_id' }))
    },
  }
}
