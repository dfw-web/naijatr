import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gatePlayback } from './playbackGate'

/** Just enough of a <video> for the gate: a playhead, buffered ranges, play/pause and events. */
function fakeVideo() {
  const video = new EventTarget() as EventTarget & {
    currentTime: number
    paused: boolean
    autoplay: boolean
    ranges: [number, number][]
    buffered: TimeRanges
    play: ReturnType<typeof vi.fn<() => Promise<void>>>
    pause: ReturnType<typeof vi.fn<() => void>>
  }
  video.currentTime = 0
  video.paused = true
  video.autoplay = true
  video.ranges = []
  Object.defineProperty(video, 'buffered', {
    get: () => ({
      length: video.ranges.length,
      start: (i: number) => video.ranges[i][0],
      end: (i: number) => video.ranges[i][1],
    }),
  })
  video.play = vi.fn(async () => {
    video.paused = false
    video.dispatchEvent(new Event('play'))
  })
  video.pause = vi.fn(() => {
    video.paused = true
    video.dispatchEvent(new Event('pause'))
  })
  return video
}

let gate: ReturnType<typeof gatePlayback> | undefined

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  gate?.remove()
  vi.useRealTimers()
})

/** A video already playing at 100 s with `ahead` seconds buffered. */
function playing(ahead: number) {
  const video = fakeVideo()
  video.ranges = [[0, 120]]
  video.currentTime = 100
  gate = gatePlayback(video as unknown as HTMLVideoElement)
  gate.check()
  expect(video.play).toHaveBeenCalledTimes(1)
  video.ranges = [[0, 100 + ahead]]
  return video
}

describe('football stream buffer gate', () => {
  it('waits for some video before starting', () => {
    const video = fakeVideo()
    video.ranges = [[0, 3]]
    gate = gatePlayback(video as unknown as HTMLVideoElement)
    gate.check()
    expect(video.play).not.toHaveBeenCalled()
    video.ranges = [[0, 16]]
    gate.check()
    expect(video.play).toHaveBeenCalledTimes(1)
  })

  it('leaves a momentary hiccup to the browser while video is still buffered', () => {
    const video = playing(9)
    video.dispatchEvent(new Event('waiting'))
    expect(video.pause).not.toHaveBeenCalled()
    expect(video.paused).toBe(false)
  })

  it('pauses on a real stall, and plays again once 8 seconds are ready', () => {
    const video = playing(0.2)
    video.dispatchEvent(new Event('waiting'))
    expect(video.pause).toHaveBeenCalledTimes(1)

    video.ranges = [[0, 106]]
    vi.advanceTimersByTime(1000)
    expect(video.play).toHaveBeenCalledTimes(1)
    video.ranges = [[0, 108.5]]
    vi.advanceTimersByTime(1000)
    expect(video.play).toHaveBeenCalledTimes(2)
  })

  it('never holds a stall for more than 5 seconds once some video is ready', () => {
    const video = playing(0.2)
    video.dispatchEvent(new Event('waiting'))
    video.ranges = [[0, 102]]
    vi.advanceTimersByTime(4000)
    expect(video.play).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2000)
    expect(video.play).toHaveBeenCalledTimes(2)
  })

  it("leaves the viewer's own pause alone", () => {
    const video = playing(9)
    video.pause()
    video.ranges = [[0, 130]]
    vi.advanceTimersByTime(10_000)
    expect(video.play).toHaveBeenCalledTimes(1)
    expect(video.paused).toBe(true)
  })
})
