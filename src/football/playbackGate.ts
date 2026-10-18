/** The football stream player's buffer handling (HlsPlayer in MatchStream.tsx). */

const START_AHEAD_S = 15
/** These feeds usually keep 8-11 s buffered, so wait for no more than that after a stall. */
const RESUME_AHEAD_S = 8
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
  video.autoplay = false

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
    if (ready < (started ? RESUME_AHEAD_S : START_AHEAD_S) && !waitedLong) return
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
    remove() {
      window.clearInterval(timer)
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('play', onPlay)
    },
  }
}
