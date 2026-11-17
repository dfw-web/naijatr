import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseBackend } from './backend'
import type { DramaRow } from './merge'

/**
 * "Your short dramas" with where the viewer stopped: sent in the progress
 * columns (006_drama_progress.sql), and still synced without them until that
 * migration runs.
 */
function fakeClient(hasProgressColumns: boolean) {
  const selects: string[] = []
  const upserts: Record<string, unknown>[][] = []
  const result = (data: unknown, error: unknown = null) => ({ data, error })
  const missing = { code: '42703', message: 'column drama_history.episode_id does not exist' }
  const from = (table: string) => {
    const builder = {
      select(columns: string) {
        if (table === 'drama_history') selects.push(columns)
        const fails = table === 'drama_history' && !hasProgressColumns && columns.includes('episode_id')
        const chain = {
          eq: () => chain,
          order: () => chain,
          limit: () => Promise.resolve(fails ? result(null, missing) : result([])),
          maybeSingle: () => Promise.resolve(result(null)),
        }
        return chain
      },
      upsert(rows: Record<string, unknown>[]) {
        if (table === 'drama_history') upserts.push(rows)
        const fails = table === 'drama_history' && !hasProgressColumns && rows.some((row) => 'episode_id' in row)
        return Promise.resolve(fails ? result(null, { code: 'PGRST204', message: "Could not find the 'episode_id' column" }) : result(null))
      },
    }
    return builder
  }
  return { client: { from: vi.fn(from) } as unknown as SupabaseClient, selects, upserts }
}

const row: DramaRow = {
  user_id: 'u1',
  entry_id: 'dramabox:1',
  provider: 'dramabox',
  drama_id: '1',
  title: 'One',
  poster: null,
  episode: 12,
  episode_count: 80,
  viewed_at: '2026-11-17T10:00:00.000Z',
  episode_id: 'ep12',
  position_s: 225,
  duration_s: 95,
}

describe('short dramas on the account', () => {
  it('sends and loads where the viewer stopped', async () => {
    const fake = fakeClient(true)
    const backend = supabaseBackend(fake.client, 'u1')
    expect((await backend.pull()).dramaRows).toEqual([])
    expect(fake.selects).toEqual(['user_id,entry_id,provider,drama_id,title,poster,episode,episode_count,viewed_at,episode_id,position_s,duration_s'])
    await backend.upsertDramas([row])
    expect(fake.upserts).toHaveLength(1)
    expect(fake.upserts[0][0]).toMatchObject({ episode_id: 'ep12', position_s: 225, duration_s: 95 })
  })

  it('still syncs them without those columns (migration not run yet)', async () => {
    const fake = fakeClient(false)
    const backend = supabaseBackend(fake.client, 'u1')
    expect((await backend.pull()).dramaRows).toEqual([])
    expect(fake.selects[1]).toBe('user_id,entry_id,provider,drama_id,title,poster,episode,episode_count,viewed_at')
    await backend.upsertDramas([row])
    // Sent once, without the progress (it knows from the load).
    expect(fake.upserts).toHaveLength(1)
    expect(fake.upserts[0][0]).not.toHaveProperty('episode_id')
    expect(fake.upserts[0][0]).toMatchObject({ entry_id: 'dramabox:1', episode: 12 })

    // Not loaded first: the upsert finds out and sends again without them.
    const fresh = fakeClient(false)
    await supabaseBackend(fresh.client, 'u1').upsertDramas([row])
    expect(fresh.upserts).toHaveLength(2)
    expect(fresh.upserts[1][0]).not.toHaveProperty('position_s')
  })
})
