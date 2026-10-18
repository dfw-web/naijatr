import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HEARTBEAT_MS, startLiveHeartbeat, useLiveWatching, useMatchWatchers, type LiveItem } from './heartbeat'

let beats: { sid: string; state: string; item: string | null }[]
let visibility: DocumentVisibilityState
let visibilitySpy: { mockRestore: () => void }

const setVisibility = (state: DocumentVisibilityState) => {
  visibility = state
  document.dispatchEvent(new Event('visibilitychange'))
}

/** Lets the pending fetch and its answer settle. */
const settle = () => act(async () => {})

beforeEach(() => {
  vi.useFakeTimers()
  beats = []
  visibility = 'visible'
  visibilitySpy = vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      beats.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify({ watching: 5 }))
    }),
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  visibilitySpy.mockRestore()
})

describe('live heartbeat', () => {
  it('says "browsing" at once and then once a minute, with the same anonymous id', async () => {
    startLiveHeartbeat()
    await settle()
    expect(beats).toEqual([{ sid: expect.stringMatching(/^[A-Za-z0-9_-]{16,64}$/), state: 'browse', item: null }])
    await act(() => vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2))
    expect(beats).toHaveLength(3)
    expect(new Set(beats.map((b) => b.sid)).size).toBe(1)
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/api/live/heartbeat')
  })

  it('says "watching" while a player is open, and stops when it closes', async () => {
    startLiveHeartbeat()
    const { rerender, unmount } = renderHook(({ item }: { item: LiveItem | null }) => useLiveWatching(item), {
      initialProps: { item: 'movie:550' as LiveItem | null },
    })
    await act(() => vi.advanceTimersByTimeAsync(2000))
    expect(beats.at(-1)).toMatchObject({ state: 'watch', item: 'movie:550' })

    await act(() => vi.advanceTimersByTimeAsync(HEARTBEAT_MS))
    expect(beats.at(-1)).toMatchObject({ state: 'watch', item: 'movie:550' })

    rerender({ item: 'tv:1399' })
    await act(() => vi.advanceTimersByTimeAsync(2000))
    expect(beats.at(-1)).toMatchObject({ state: 'watch', item: 'tv:1399' })

    unmount()
    await act(() => vi.advanceTimersByTimeAsync(2000))
    expect(beats.at(-1)).toMatchObject({ state: 'browse', item: null })
  })

  it('sends nothing while the tab is hidden, and catches up when it comes back', async () => {
    startLiveHeartbeat()
    renderHook(() => useLiveWatching('match:7'))
    await act(() => vi.advanceTimersByTimeAsync(2000))
    const before = beats.length

    setVisibility('hidden')
    await act(() => vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 5))
    expect(beats).toHaveLength(before)

    setVisibility('visible')
    await settle()
    expect(beats).toHaveLength(before + 1)
    expect(beats.at(-1)).toMatchObject({ state: 'watch', item: 'match:7' })
  })

  it('sends nothing until started (localhost, tests)', async () => {
    renderHook(() => useLiveWatching('movie:550'))
    await act(() => vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2))
    expect(beats).toEqual([])
  })

  it("reports how many are watching the match page's match", async () => {
    startLiveHeartbeat()
    const { result } = renderHook(() => useMatchWatchers('match:7'))
    expect(result.current).toBeNull()
    await act(() => vi.advanceTimersByTimeAsync(2000))
    expect(beats.at(-1)).toMatchObject({ state: 'browse', item: 'match:7' })
    expect(result.current).toBe(5)
  })
})
