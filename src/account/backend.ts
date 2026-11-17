import type { SupabaseClient } from '@supabase/supabase-js'
import { isTasteProfile, type ContinueRow, type DramaRow, type ListRow } from './merge'
import type { SyncBackend } from './sync'

const CONTINUE_COLUMNS =
  'user_id,title_id,tmdb_id,media_type,season,episode,progress_seconds,duration_seconds,last_watched_at,title,poster_path,data'
const LIST_COLUMNS = 'user_id,title_id,tmdb_id,media_type,title,poster_path,saved_at,data'
const DRAMA_COLUMNS = 'user_id,entry_id,provider,drama_id,title,poster,episode,episode_count,viewed_at'
/** Where the viewer stopped (supabase/migrations/006_drama_progress.sql). */
const DRAMA_PROGRESS_COLUMNS = 'episode_id,position_s,duration_s'

/** PostgREST's "no such column" (the 006 migration not run yet). */
const missingColumn = (error: unknown) => {
  const e = error as { code?: string; message?: string } | null
  return e?.code === '42703' || e?.code === 'PGRST204' || /column/i.test(e?.message ?? '')
}

const withoutProgress = (row: DramaRow): DramaRow => {
  const { episode_id: _id, position_s: _at, duration_s: _length, ...rest } = row
  return rest
}

/** Throws on an error, so sync treats it as a failed try. */
const ok = <T>({ data, error }: { data: T; error: unknown }): T => {
  if (error) throw error
  return data
}

/**
 * The account's tables in Supabase (supabase/migrations/001_sync.sql, and
 * 005_drama_history.sql for "Your short dramas"). Row
 * Level Security lets each user reach only their own rows; user_id is still
 * named in every query so nothing else is ever asked for.
 */
export function supabaseBackend(client: SupabaseClient, userId: string): SyncBackend {
  const now = () => new Date().toISOString()
  // Until 006_drama_progress.sql runs, short dramas sync without where the viewer stopped.
  let progressColumns = true
  const loadDramas = async () => {
    const query = (columns: string) =>
      client.from('drama_history').select(columns).eq('user_id', userId).order('viewed_at', { ascending: false }).limit(50)
    if (progressColumns) {
      const full = await query(`${DRAMA_COLUMNS},${DRAMA_PROGRESS_COLUMNS}`)
      if (!full.error || !missingColumn(full.error)) return full
      progressColumns = false
    }
    return query(DRAMA_COLUMNS)
  }
  return {
    async pull() {
      const [cw, list, taste, dramas] = await Promise.all([
        client.from('continue_watching').select(CONTINUE_COLUMNS).eq('user_id', userId).limit(100),
        client.from('my_list').select(LIST_COLUMNS).eq('user_id', userId).limit(200),
        client.from('taste_profile').select('profile').eq('user_id', userId).maybeSingle(),
        loadDramas(),
      ])
      const profile = (ok(taste) as { profile?: unknown } | null)?.profile
      return {
        continueRows: (ok(cw) ?? []) as ContinueRow[],
        listRows: (ok(list) ?? []) as ListRow[],
        taste: isTasteProfile(profile) ? profile : null,
        // An error here (no table yet) leaves short dramas out, not the rest.
        dramaRows: dramas.error ? null : ((dramas.data ?? []) as unknown as DramaRow[]),
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
    async upsertDramas(rows) {
      const send = (list: DramaRow[]) =>
        client.from('drama_history').upsert(list.map((row) => ({ ...row, updated_at: now() })), { onConflict: 'user_id,entry_id' })
      if (progressColumns) {
        const sent = await send(rows)
        if (!sent.error || !missingColumn(sent.error)) return void ok(sent)
        progressColumns = false
      }
      ok(await send(rows.map(withoutProgress)))
    },
    async deleteDramas(ids) {
      ok(await client.from('drama_history').delete().eq('user_id', userId).in('entry_id', ids))
    },
    async saveTaste(profile) {
      ok(await client.from('taste_profile').upsert({ user_id: userId, profile, updated_at: now() }, { onConflict: 'user_id' }))
    },
  }
}
