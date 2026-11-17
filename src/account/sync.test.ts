import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaItem } from '../types/media'
import { emptyProfile, readTaste, recordTaste, type TasteProfile } from '../taste/profile'
import {
  readContinueWatching,
  recordPlay,
  recordProgress,
  removeEntry,
  resetContinueWatching,
  type ContinueEntry,
} from '../utils/continueWatching'
import { readWatchLater, removeFromLater, saveForLater } from '../utils/watchLater'
import { readDramaHistory, recordDramaProgress, recordDramaView, removeDramaEntry, resetDramaHistory, setDramaEpisode, type DramaHistoryEntry } from '../dramas/history'
import {
  combineTaste,
  continueEntry,
  continueRow,
  dramaEntry,
  dramaRow,
  mergeContinue,
  mergeDramas,
  mergeList,
  type ContinueRow,
  type DramaRow,
  type ListRow,
} from './merge'
import { requestSyncNow, resetSync, startSync, stopSync, syncSettled, type SyncBackend } from './sync'

const movie = (id: number, title = `Movie ${id}`): MediaItem => ({
  id: `tmdb-movie-${id}`,
  tmdbId: id,
  title,
  type: 'movie',
  year: 2020,
  releaseDate: null,
  genres: [],
  genreIds: [28],
  score: 7,
  voteCount: 10,
  popularity: 1,
  description: '',
  poster: `/p${id}.jpg`,
  backdrop: null,
})
const show: MediaItem = {
  ...movie(1399, 'Game of Thrones'),
  id: 'tmdb-series-1399',
  type: 'series',
  seasons: [{ number: 1, name: 'Season 1', episodeCount: 10 }],
}

/**
 * One account in memory, shared by "phones"; `down` makes every call fail
 * (offline); `noDramaTable` is an account whose short-drama table isn't set
 * up yet (005_drama_history.sql not run).
 */
function fakeAccount() {
  const data = {
    cw: new Map<string, ContinueRow>(),
    list: new Map<string, ListRow>(),
    dramas: new Map<string, DramaRow>(),
    taste: null as TasteProfile | null,
  }
  let down = false
  let noDramaTable = false
  const check = () => {
    if (down) return Promise.reject(new Error('offline'))
    return Promise.resolve()
  }
  const backend: SyncBackend = {
    pull: async () => {
      await check()
      return {
        continueRows: [...data.cw.values()],
        listRows: [...data.list.values()],
        taste: data.taste,
        dramaRows: noDramaTable ? null : [...data.dramas.values()].map((row) => structuredClone(row)),
      }
    },
    upsertDramas: async (rows) => {
      await check()
      if (noDramaTable) throw new Error('no drama_history table')
      rows.forEach((row) => data.dramas.set(row.entry_id, structuredClone(row)))
    },
    deleteDramas: async (ids) => {
      await check()
      if (noDramaTable) throw new Error('no drama_history table')
      ids.forEach((id) => data.dramas.delete(id))
    },
    upsertContinue: async (rows) => {
      await check()
      rows.forEach((row) => data.cw.set(row.title_id, structuredClone(row)))
    },
    deleteContinue: async (ids) => {
      await check()
      ids.forEach((id) => data.cw.delete(id))
    },
    upsertList: async (rows) => {
      await check()
      rows.forEach((row) => data.list.set(row.title_id, structuredClone(row)))
    },
    deleteList: async (ids) => {
      await check()
      ids.forEach((id) => data.list.delete(id))
    },
    saveTaste: async (profile) => {
      await check()
      data.taste = structuredClone(profile)
    },
  }
  return { data, backend, setDown: (value: boolean) => (down = value), setNoDramaTable: (value: boolean) => (noDramaTable = value) }
}

/** Switches to another phone: its own (empty, or earlier) localStorage. */
const phones = new Map<string, Record<string, string>>()
function useDevice(name: string) {
  stopSync()
  const current = phones.get('__current')
  if (current) phones.set(current as unknown as string, { ...localStorage })
  localStorage.clear()
  Object.entries(phones.get(name) ?? {}).forEach(([key, value]) => localStorage.setItem(key, value))
  phones.set('__current', name as unknown as Record<string, string>)
  resetContinueWatching()
  resetDramaHistory()
}

const drama = (dramaId: string, title = `Drama ${dramaId}`, episodeCount: number | null = 80) => ({
  provider: 'dramabox',
  dramaId,
  title,
  poster: `https://img.example/${dramaId}.jpg`,
  episodeCount,
})

const dramaItem = (over: Partial<DramaHistoryEntry>): DramaHistoryEntry => ({
  id: 'dramabox:1',
  provider: 'dramabox',
  dramaId: '1',
  title: 'One',
  poster: null,
  episode: null,
  episodeId: null,
  position: null,
  duration: null,
  episodeCount: 80,
  viewedAt: 1,
  ...over,
})

const entry = (over: Partial<ContinueEntry>): ContinueEntry => ({
  id: 'a',
  type: 'movie',
  tmdbId: 1,
  title: 'A',
  poster: null,
  backdrop: null,
  season: null,
  episode: null,
  episodeTitle: null,
  still: null,
  progressSeconds: 10,
  durationSeconds: 100,
  lastWatchedAt: 1,
  seasons: [],
  source: 'stream',
  item: movie(1),
  ...over,
})

let fetchSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  phones.clear()
  // Episode names (continueWatching's TMDB lookup): none in tests.
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in tests'))
})

afterEach(() => {
  resetSync()
  fetchSpy.mockRestore()
})

describe('merging', () => {
  it('keeps the newest of the same title, and the account’s titles this device never had', () => {
    const local = [entry({ id: 'a', lastWatchedAt: 50, progressSeconds: 500 }), entry({ id: 'b', lastWatchedAt: 10 })]
    const remote = [entry({ id: 'a', lastWatchedAt: 40, progressSeconds: 400 }), entry({ id: 'b', lastWatchedAt: 20 }), entry({ id: 'c', lastWatchedAt: 5 })]
    const merged = mergeContinue(local, remote, { a: 'up', b: 'up' })
    expect(merged.list.map((e) => [e.id, e.lastWatchedAt])).toEqual([
      ['a', 50],
      ['b', 20],
      ['c', 5],
    ])
    // Only the local winner goes up.
    expect(merged.upload.map((e) => e.id)).toEqual(['a'])
  })

  it('takes the account’s data when nothing here is pending, and keeps removals removed', () => {
    const merged = mergeContinue([entry({ id: 'x', lastWatchedAt: 99 })], [entry({ id: 'a' }), entry({ id: 'b' })], { b: 'del' })
    expect(merged.list.map((e) => e.id)).toEqual(['a'])
    expect(merged.remove).toEqual(['b'])
  })

  it('keeps an entry here that’s newer than the account’s copy (sent while the account was loading)', () => {
    const merged = mergeContinue([entry({ id: 'a', lastWatchedAt: 50, progressSeconds: 1500 })], [entry({ id: 'a', lastWatchedAt: 40, progressSeconds: 1200 })], {})
    expect(merged.list[0]).toMatchObject({ progressSeconds: 1500 })
    expect(merged.upload).toEqual([])
  })

  it('carries the player’s source to the account and back; the newest entry’s source wins', () => {
    const mine = entry({ id: 'a', lastWatchedAt: 50, playerSource: 'MovieJoy' })
    expect(continueEntry(continueRow('u', mine))).toMatchObject({ playerSource: 'MovieJoy' })
    // Rows saved before it existed.
    expect(continueEntry({ ...continueRow('u', mine), data: { ...continueRow('u', mine).data, playerSource: undefined } })).toMatchObject({ playerSource: null })
    const merged = mergeContinue([mine], [entry({ id: 'a', lastWatchedAt: 60, playerSource: 'VidStore' })], { a: 'up' })
    expect(merged.list[0]).toMatchObject({ playerSource: 'VidStore' })
  })

  it('keeps the newest of each short drama, and the newest 20 in all', () => {
    const local = [dramaItem({ episode: 12, viewedAt: 50 })]
    const remote = [dramaItem({ episode: 3, viewedAt: 10 }), dramaItem({ id: 'netshort:9', provider: 'netshort', dramaId: '9', viewedAt: 40 })]
    const merged = mergeDramas(local, remote, { 'dramabox:1': 'up' })
    expect(merged.list.map((e) => [e.id, e.episode])).toEqual([
      ['dramabox:1', 12],
      ['netshort:9', null],
    ])
    expect(merged.upload.map((e) => e.id)).toEqual(['dramabox:1'])

    // The newer episode wins, whichever phone set it.
    expect(mergeDramas([dramaItem({ episode: 30, viewedAt: 90 })], [dramaItem({ episode: 5, viewedAt: 20 })], { 'dramabox:1': 'up' }).list[0].episode).toBe(30)
    expect(mergeDramas([dramaItem({ episode: 30, viewedAt: 10 })], [dramaItem({ episode: 5, viewedAt: 20 })], { 'dramabox:1': 'up' }).list[0].episode).toBe(5)

    const many = Array.from({ length: 24 }, (_, i) => dramaItem({ id: `dramabox:${i}`, dramaId: String(i), viewedAt: i }))
    const capped = mergeDramas([], many, {})
    expect(capped.list).toHaveLength(20)
    expect(capped.list[0].id).toBe('dramabox:23')
    expect(capped.remove.sort()).toEqual(['dramabox:0', 'dramabox:1', 'dramabox:2', 'dramabox:3'])
  })

  it('turns short dramas into account rows and back', () => {
    const entry = dramaItem({ episode: 12, poster: 'https://img.example/p.jpg', viewedAt: Date.parse('2026-11-17T10:00:00Z') })
    const row = dramaRow('user-1', entry)
    expect(row).toEqual({
      user_id: 'user-1',
      entry_id: 'dramabox:1',
      provider: 'dramabox',
      drama_id: '1',
      title: 'One',
      poster: 'https://img.example/p.jpg',
      episode: 12,
      episode_count: 80,
      viewed_at: '2026-11-17T10:00:00.000Z',
      episode_id: null,
      position_s: null,
      duration_s: null,
    })
    expect(dramaEntry(row)).toEqual(entry)
    expect(dramaEntry({ ...row, entry_id: 'dramabox:2' })).toBeNull()
    expect(dramaRow('user-1', { ...entry, poster: `https://x/${'a'.repeat(1200)}` }).poster).toBeNull()
  })

  it('joins both My Lists', () => {
    const item = movie(1)
    const merged = mergeList(
      [{ id: 'a', savedAt: 3, item }],
      [
        { id: 'b', savedAt: 2, item },
        { id: 'a', savedAt: 1, item },
      ],
      { a: 'up' },
    )
    expect(merged.list.map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('combines two taste profiles', () => {
    const now = Date.now()
    const a: TasteProfile = { ...emptyProfile(), attrs: { 'g:28': { s: 5, t: now }, 'g:35': { s: 1, t: now } }, hidden: ['x'], asked: true }
    const b: TasteProfile = { ...emptyProfile(), attrs: { 'g:35': { s: 8, t: now }, 'g:18': { s: 2, t: now } }, hidden: ['y'] }
    const both = combineTaste(a, b, now)
    expect(both.attrs['g:28'].s).toBeCloseTo(5)
    expect(both.attrs['g:35'].s).toBeCloseTo(8)
    expect(both.attrs['g:18'].s).toBeCloseTo(2)
    expect(both.hidden.sort()).toEqual(['x', 'y'])
    expect(both.asked).toBe(true)
  })
})

describe('syncing', () => {
  it('puts this device’s data in the account on the first sign-in', async () => {
    const account = fakeAccount()
    useDevice('phone')
    recordPlay(movie(550, 'Fight Club'))
    recordProgress('tmdb-movie-550', {}, 1200, 8000)
    saveForLater(movie(27205, 'Inception'))
    recordTaste(movie(550), 'play')
    await startSync('user-1', account.backend)
    expect(account.data.cw.get('tmdb-movie-550')).toMatchObject({ user_id: 'user-1', progress_seconds: 1200, duration_seconds: 8000, media_type: 'movie' })
    expect([...account.data.list.keys()]).toEqual(['tmdb-movie-27205'])
    expect(account.data.taste?.titles.map((t) => t.id)).toEqual(['tmdb-movie-550'])
  })

  it('resumes on another phone at the same episode and time, with the same My List', async () => {
    const account = fakeAccount()
    useDevice('phone A')
    await startSync('user-1', account.backend)
    recordPlay(show, { season: 1, episode: 3 })
    recordProgress(show.id, { season: 1, episode: 3 }, 754, 3300)
    saveForLater(movie(27205, 'Inception'))
    await requestSyncNow()

    useDevice('phone B')
    expect(readContinueWatching()).toEqual([])
    await startSync('user-1', account.backend)
    const [resumed] = readContinueWatching()
    expect(resumed).toMatchObject({ id: show.id, season: 1, episode: 3, progressSeconds: 754, durationSeconds: 3300 })
    expect(readWatchLater().map((e) => e.id)).toEqual(['tmdb-movie-27205'])

    // Phone B watches on; phone A picks it up next time it loads the account.
    recordProgress(show.id, { season: 1, episode: 3 }, 2000, 3300)
    await requestSyncNow()
    useDevice('phone A')
    await startSync('user-1', account.backend)
    expect(readContinueWatching()[0]).toMatchObject({ season: 1, episode: 3, progressSeconds: 2000 })
  })

  it('carries removals to the other phone', async () => {
    const account = fakeAccount()
    useDevice('phone A')
    await startSync('user-1', account.backend)
    recordPlay(movie(1))
    saveForLater(movie(2))
    await requestSyncNow()
    useDevice('phone B')
    await startSync('user-1', account.backend)
    expect(readContinueWatching()).toHaveLength(1)
    removeEntry('tmdb-movie-1')
    removeFromLater('tmdb-movie-2')
    await requestSyncNow()
    expect(account.data.cw.size).toBe(0)
    expect(account.data.list.size).toBe(0)
    useDevice('phone A')
    await startSync('user-1', account.backend)
    expect(readContinueWatching()).toEqual([])
    expect(readWatchLater()).toEqual([])
  })

  it('keeps working offline and catches up once it can reach the account', async () => {
    const account = fakeAccount()
    useDevice('phone')
    await startSync('user-1', account.backend)
    account.setDown(true)
    recordPlay(movie(7))
    recordProgress('tmdb-movie-7', {}, 300, 6000)
    await requestSyncNow()
    // Still here, and still to be sent.
    expect(readContinueWatching()[0]).toMatchObject({ progressSeconds: 300 })
    expect(account.data.cw.size).toBe(0)
    expect(JSON.parse(localStorage.getItem('naijatr.sync.pending')!).cw).toEqual({ 'tmdb-movie-7': 'up' })

    account.setDown(false)
    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(account.data.cw.get('tmdb-movie-7')?.progress_seconds).toBe(300))
  })

  it('doesn’t let an older phone’s data overwrite newer progress', async () => {
    const account = fakeAccount()
    useDevice('phone A')
    recordPlay(movie(9), {}, 1000)
    recordProgress('tmdb-movie-9', {}, 100, 6000, 1000)
    useDevice('phone B')
    await startSync('user-1', account.backend)
    recordPlay(movie(9), {}, 5000)
    recordProgress('tmdb-movie-9', {}, 4000, 6000, 5000)
    await requestSyncNow()
    // Phone A signs in for the first time, with its older progress.
    useDevice('phone A')
    await startSync('user-1', account.backend)
    expect(readContinueWatching()[0]).toMatchObject({ progressSeconds: 4000 })
    expect(account.data.cw.get('tmdb-movie-9')?.progress_seconds).toBe(4000)
  })

  it('lets a Play wait for the account’s data while it loads', async () => {
    const account = fakeAccount()
    useDevice('phone')
    let release = () => undefined as void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const pull = account.backend.pull
    account.backend.pull = async () => {
      await gate
      return pull()
    }
    const started = startSync('user-1', account.backend)
    let done = false
    void syncSettled(10_000).then(() => (done = true))
    await Promise.resolve()
    expect(done).toBe(false)
    release()
    await started
    await vi.waitFor(() => expect(done).toBe(true))
    // Loaded: at once.
    await syncSettled(10_000)
  })

  it('shows the same short dramas, episode and all, on another phone', async () => {
    const account = fakeAccount()
    useDevice('phone A')
    // Signed out first: kept on this phone only.
    recordDramaView(drama('42000023802', 'He Broke the Heart That Saved Him', 52), 1000)
    setDramaEpisode('dramabox:42000023802', 12, 2000)
    await startSync('user-1', account.backend)
    expect(account.data.dramas.get('dramabox:42000023802')).toMatchObject({ user_id: 'user-1', episode: 12, episode_count: 52 })

    useDevice('phone B')
    expect(readDramaHistory()).toEqual([])
    recordDramaView(drama('7'), 1500)
    await startSync('user-1', account.backend)
    expect(readDramaHistory().map((e) => [e.id, e.episode])).toEqual([
      ['dramabox:42000023802', 12],
      ['dramabox:7', null],
    ])

    // Phone B moves on to episode 20; phone A sees it next time it loads the account.
    setDramaEpisode('dramabox:42000023802', 20)
    await requestSyncNow()
    useDevice('phone A')
    await startSync('user-1', account.backend)
    expect(readDramaHistory()[0]).toMatchObject({ id: 'dramabox:42000023802', episode: 20, episodeCount: 52 })
    expect(readDramaHistory()).toHaveLength(2)
  })

  it('resumes a short drama on another phone at the same episode and time', async () => {
    const account = fakeAccount()
    useDevice('phone A')
    await startSync('user-1', account.backend)
    recordDramaView(drama('42000023802', 'He Broke the Heart That Saved Him', 52), 1000)
    recordDramaProgress('dramabox:42000023802', { episode: 12, episodeId: 'ep12', position: 225, duration: 95 }, 2000)
    await requestSyncNow()
    expect(account.data.dramas.get('dramabox:42000023802')).toMatchObject({ episode: 12, episode_id: 'ep12', position_s: 225, duration_s: 95 })

    useDevice('phone B')
    await startSync('user-1', account.backend)
    expect(readDramaHistory()[0]).toMatchObject({ episode: 12, episodeId: 'ep12', position: 225, duration: 95 })
  })

  it('carries a removed short drama to the other phone', async () => {
    const account = fakeAccount()
    useDevice('phone A')
    await startSync('user-1', account.backend)
    recordDramaView(drama('1'))
    recordDramaView(drama('2'))
    await requestSyncNow()
    useDevice('phone B')
    await startSync('user-1', account.backend)
    expect(readDramaHistory()).toHaveLength(2)
    removeDramaEntry('dramabox:1')
    await requestSyncNow()
    expect([...account.data.dramas.keys()]).toEqual(['dramabox:2'])
    useDevice('phone A')
    await startSync('user-1', account.backend)
    expect(readDramaHistory().map((e) => e.id)).toEqual(['dramabox:2'])
  })

  it('keeps short dramas on the phone while the account has no table for them, and the rest syncs', async () => {
    const account = fakeAccount()
    account.setNoDramaTable(true)
    useDevice('phone')
    await startSync('user-1', account.backend)
    recordDramaView(drama('5'))
    setDramaEpisode('dramabox:5', 4)
    recordPlay(movie(550))
    await requestSyncNow()
    expect(account.data.cw.has('tmdb-movie-550')).toBe(true)
    expect(account.data.dramas.size).toBe(0)
    expect(readDramaHistory()[0]).toMatchObject({ id: 'dramabox:5', episode: 4 })
    const pending = JSON.parse(localStorage.getItem('naijatr.sync.pending')!)
    expect(pending.cw).toEqual({})
    expect(pending.dramas).toEqual({ 'dramabox:5': 'up' })

    // The table is set up: the next load sends them.
    account.setNoDramaTable(false)
    stopSync()
    await startSync('user-1', account.backend)
    expect(account.data.dramas.get('dramabox:5')).toMatchObject({ episode: 4 })
    expect(readDramaHistory()[0]).toMatchObject({ id: 'dramabox:5', episode: 4 })
  })

  it('sends nothing while signed out', async () => {
    const account = fakeAccount()
    useDevice('phone')
    await startSync('user-1', account.backend)
    stopSync()
    recordPlay(movie(3))
    saveForLater(movie(4))
    await requestSyncNow()
    expect(account.data.cw.size).toBe(0)
    expect(account.data.list.size).toBe(0)
    // Still on this device, as always.
    expect(readContinueWatching()).toHaveLength(1)
    expect(readWatchLater()).toHaveLength(1)
    expect(readTaste()).toBeDefined()
  })
})
