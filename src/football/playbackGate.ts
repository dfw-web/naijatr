/** The football stream player's buffer handling (HlsPlayer in MatchStream.tsx). */

const START_AHEAD_S = 15
/** These feeds usually keep 8-11 s buffered, so wait for no more than that after a stall. */
const RESUME_AHEAD_S = 8
/**
 * A live playlist holds only so much video (6 s on some feeds), and no more
 * can be buffered ahead than that: wait for at most this share of it.
 */
const WINDOW_SHARE = 0.5
const MAX_GAP_S = 6
/** Play anyway after this long if some video is ready but the target isn't reached. */
const MAX_HOLD_MS = 5000
/** A "waiting" with at least this much video buffered is a momentary hiccup, not a stall: leave it to the browser. */
const HICCUP_AHEAD_S = 1

/**
 * Starts playback only with a few seconds of video ready, and after a real
 * stall (the buffer ran out) waits for some again, so a slow feed pauses
 * briefly now and then instead of stuttering constantly. Momentary hiccups
 * with video still buffered are left to the browser, which carries on by
 * itself. Small holes in the stream are skipped. A pause by the viewer is
 * left alone.
 */
export function gatePlayback(video: HTMLVideoElement) {
  let started = false
  let holding = true
  let holdSince = performance.now()
  let pausedByUs = false
  /** Seconds of video the live playlist holds, once known. */
  let windowS = Infinity
  video.autoplay = false

  const target = () => Math.min(started ? RESUME_AHEAD_S : START_AHEAD_S, windowS * WINDOW_SHARE)

  /** Seconds buffered from the current position; jumps a small hole first. */
  const ahead = () => {
    const t = video.currentTime
    const { buffered } = video
    for (let i = 0; i < buffered.length; i += 1) {
      if (buffered.start(i) <= t + 0.25 && buffered.end(i) > t) return buffered.end(i) - t
      if (buffered.start(i) > t && buffered.start(i) - t <= MAX_GAP_S) {
        video.currentTime = buffered.start(i) + 0.05
        return buffered.end(i) - video.currentTime
      }
    }
    return 0
  }

  const check = () => {
    if (!holding) return
    const ready = ahead()
    const waitedLong = ready > 0.5 && performance.now() - holdSince > MAX_HOLD_MS
    if (ready < target() && !waitedLong) return
    holding = false
    started = true
    pausedByUs = false
    void video.play().catch(() => undefined)
  }

  const onWaiting = () => {
    if (video.paused || holding) return
    // Still video to play: a hiccup, not a stall. Pausing here would turn it into a long wait.
    if (ahead() >= HICCUP_AHEAD_S) return
    holding = true
    holdSince = performance.now()
    pausedByUs = true
    video.pause()
    check()
  }
  // The viewer paused (not us): stop managing until they press play.
  const onPause = () => {
    if (!pausedByUs) holding = false
  }
  const onPlay = () => {
    if (!pausedByUs) holding = false
  }

  video.addEventListener('waiting', onWaiting)
  video.addEventListener('pause', onPause)
  video.addEventListener('play', onPlay)
  const timer = window.setInterval(check, 1000)
  return {
    check,
    /** The live playlist's length in seconds (from hls.js), so the waits fit the feed. */
    setWindow(seconds: number) {
      if (seconds > 0) windowS = seconds
      check()
    },
    /** Whether it's holding playback back (waiting for video), rather than the viewer having paused. */
    get holding() {
      return holding
    },
    remove() {
      window.clearInterval(timer)
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('play', onPlay)
    },
  }
}

/** A server whose picture hasn't moved for this long, while it should be playing, has failed. */
export const STUCK_MS = 20_000
const WATCH_EVERY_MS = 2000

/**
 * Calls onStuck (once) if the picture doesn't move for STUCK_MS while the
 * video should be playing: nothing loading at all, or the clock running with
 * no new frames (the feed can't keep up). The time a viewer has it paused
 * doesn't count. `shouldPlay` says whether playback is wanted right now.
 */
export function watchProgress(video: HTMLVideoElement, shouldPlay: () => boolean, onStuck: () => void) {
  const frames = () => video.getVideoPlaybackQuality?.().totalVideoFrames
  let lastFrames = frames()
  let lastTime = video.currentTime
  let stuckFor = 0
  const timer = window.setInterval(() => {
    const nowFrames = frames()
    // Frames where the browser counts them; the clock otherwise.
    const moved = nowFrames !== undefined ? nowFrames > (lastFrames ?? 0) : video.currentTime > lastTime
    lastFrames = nowFrames
    lastTime = video.currentTime
    stuckFor = moved || !shouldPlay() ? 0 : stuckFor + WATCH_EVERY_MS
    if (stuckFor >= STUCK_MS) {
      window.clearInterval(timer)
      onStuck()
    }
  }, WATCH_EVERY_MS)
  return () => window.clearInterval(timer)
}
