import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { Captions, Check } from 'lucide-react'
import { isIos } from '../pwa'
import {
  cuesAt,
  DEFAULT_LANG,
  loadLanguages,
  loadSubtitle,
  offsetKey,
  saveSubtitleOffset,
  setSubtitleChoice,
  subscribeSubtitleChoice,
  subtitleChoice,
  subtitleOffset,
  takeIphoneTip,
  type Cue,
  type SubtitleLanguage,
  type SubtitleTarget,
} from './subtitles'
import './PlayerSubtitles.css'

/**
 * Our own subtitles over the player (neither server's player takes a subtitle
 * from outside). The text follows the time the player posts to the page
 * (`{ source: 'embedmaster_player', event: 'time', info: seconds }`), so the CC
 * button only shows once a player has reported its time. Nothing is fetched
 * until the video is playing: subtitles never hold up playback.
 */

const PLAYER_EVENTS = 'embedmaster_player'
/** Between time events, the clock runs on by itself (while playing), at most this far. */
const MAX_COAST_S = 1.5
const TICK_MS = 100
export const SYNC_STEP_S = 0.5

type Status = 'off' | 'loading' | 'ready' | 'none'

const isInside = (source: MessageEventSource | null, frame: Window | null | undefined): boolean => {
  if (!source || !frame) return false
  let w: Window | null = source as Window
  for (let i = 0; i < 5 && w; i++) {
    if (w === frame) return true
    if (w.parent === w) break
    w = w.parent
  }
  return false
}

export interface PlayerSubtitles {
  /** The player reports its time: the CC button can show. */
  supported: boolean
  choice: string
  status: Status
  languages: SubtitleLanguage[]
  offset: number
  shown: Cue[]
  iphoneTip: boolean
  choose: (choice: string) => void
  nudge: (by: number) => void
}

/**
 * `target`: the title (and episode) playing, null when nothing is. `playerKey`
 * changes with each new player (server switch, retry, next episode).
 */
export function usePlayerSubtitles(target: SubtitleTarget | null, frameRef: RefObject<HTMLIFrameElement | null>, playerKey: string | null): PlayerSubtitles {
  const choice = useSyncExternalStore(subscribeSubtitleChoice, subtitleChoice, () => DEFAULT_LANG)
  const [supported, setSupported] = useState(false)
  const [time, setTime] = useState(0)
  const clock = useRef({ at: 0, time: 0, playing: false })

  // The player's clock.
  useEffect(() => {
    setSupported(false)
    if (!playerKey) return
    clock.current = { at: 0, time: 0, playing: false }
    const onMessage = (ev: MessageEvent) => {
      const data = ev.data as { source?: unknown; event?: unknown; info?: unknown } | null
      if (data?.source !== PLAYER_EVENTS || !isInside(ev.source, frameRef.current?.contentWindow)) return
      if (data.event === 'time' && typeof data.info === 'number' && Number.isFinite(data.info)) {
        clock.current = { at: performance.now(), time: data.info, playing: true }
        setSupported(true)
      }
      if (data.event === 'pause' || data.event === 'ended') clock.current = { ...clock.current, playing: false }
      if (data.event === 'play') clock.current = { ...clock.current, at: performance.now(), playing: true }
    }
    window.addEventListener('message', onMessage)
    const timer = window.setInterval(() => {
      const c = clock.current
      if (!c.at) return
      const coast = c.playing ? Math.min(MAX_COAST_S, (performance.now() - c.at) / 1000) : 0
      setTime(c.time + coast)
    }, TICK_MS)
    return () => {
      window.removeEventListener('message', onMessage)
      window.clearInterval(timer)
    }
  }, [playerKey, frameRef])

  const targetKey = target ? `${target.type}:${target.tmdbId}:${target.episode?.season ?? ''}:${target.episode?.episode ?? ''}` : null
  const active = supported && targetKey !== null

  // The languages, once it plays.
  const [languages, setLanguages] = useState<SubtitleLanguage[]>([])
  useEffect(() => {
    setLanguages([])
    if (!active || !target) return
    const ctrl = new AbortController()
    void loadLanguages(target, ctrl.signal).then((list) => !ctrl.signal.aborted && setLanguages(list))
    return () => ctrl.abort()
    // targetKey stands for target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, targetKey])

  // The subtitle itself.
  const [loaded, setLoaded] = useState<{ key: string; cues: Cue[] | null } | null>(null)
  const loadKey = active && choice !== 'off' ? `${targetKey}:${choice}` : null
  useEffect(() => {
    if (!loadKey || !target) return
    if (loaded?.key === loadKey) return
    const ctrl = new AbortController()
    void loadSubtitle(target, choice, ctrl.signal).then((cues) => !ctrl.signal.aborted && setLoaded({ key: loadKey, cues }))
    return () => ctrl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey])

  const status: Status = choice === 'off' || !active ? 'off' : loaded?.key !== loadKey ? 'loading' : loaded.cues ? 'ready' : 'none'

  // The sync offset, per title.
  const titleKey = target ? offsetKey(target) : null
  const [offset, setOffset] = useState(0)
  useEffect(() => setOffset(titleKey ? subtitleOffset(titleKey) : 0), [titleKey])
  const nudge = (by: number) => {
    const next = Math.round((offset + by) * 10) / 10
    setOffset(next)
    if (titleKey) saveSubtitleOffset(titleKey, next)
  }

  // iPhone: the player's own fullscreen is the video alone, without our text. Said once.
  const [iphoneTip, setIphoneTip] = useState(false)
  useEffect(() => {
    if (status !== 'ready' || !isIos() || !takeIphoneTip()) return
    setIphoneTip(true)
    const timer = window.setTimeout(() => setIphoneTip(false), 7000)
    return () => window.clearTimeout(timer)
  }, [status])

  const shown = status === 'ready' && loaded?.cues ? cuesAt(loaded.cues, time - offset) : []
  return { supported: active, choice, status, languages, offset, shown, iphoneTip, choose: (c) => setSubtitleChoice(c), nudge }
}

/** <i>, <b> and <u> stay; any other markup shows as text. */
function CueLine({ line }: { line: string }) {
  const parts = line.split(/(<\/?[ibu]>)/i)
  const out: React.ReactNode[] = []
  const style = { i: false, b: false, u: false }
  parts.forEach((part, n) => {
    const tag = /^<(\/)?([ibu])>$/i.exec(part)
    if (tag) {
      style[tag[2].toLowerCase() as 'i' | 'b' | 'u'] = !tag[1]
      return
    }
    if (!part) return
    let node: React.ReactNode = part.replace(/<[^>]*>/g, '')
    if (style.u) node = <u>{node}</u>
    if (style.b) node = <b>{node}</b>
    if (style.i) node = <i>{node}</i>
    out.push(<Fragment key={n}>{node}</Fragment>)
  })
  return <span className="subs__line">{out}</span>
}

/** The text over the video (inside .player__frame). */
export function SubtitleOverlay({ subs }: { subs: PlayerSubtitles }) {
  return (
    <>
      {subs.shown.length > 0 && (
        <div className="subs" aria-live="off">
          {subs.shown.map((cue, i) => (
            <p key={`${cue.start}-${i}`} className="subs__cue">
              {cue.lines.map((line, j) => (
                <Fragment key={j}>
                  {j > 0 && <br />}
                  <CueLine line={line} />
                </Fragment>
              ))}
            </p>
          ))}
        </div>
      )}
      {subs.iphoneTip && (
        <p className="subs__tip" role="status">
          Subtitles show outside fullscreen on iPhone
        </p>
      )}
    </>
  )
}

/** The CC button (in the player's bar) and its menu: Off, English, the other languages, sync. */
export function SubtitleMenu({ subs }: { subs: PlayerSubtitles }) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])
  if (!subs.supported) return null

  const others = subs.languages.filter((l) => l.code !== 'en' && l.available)
  const options = [
    { code: 'off', name: 'Off' },
    { code: 'en', name: 'English' },
    ...others.map((l) => ({ code: l.code, name: l.name })),
  ]
  const current = options.find((o) => o.code === subs.choice)?.name ?? subs.choice
  const sign = subs.offset > 0 ? '+' : subs.offset < 0 ? '−' : ''

  return (
    <div className="subs-menu" ref={boxRef}>
      <button
        type="button"
        className="btn btn--ghost subs-menu__button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-pressed={subs.choice !== 'off'}
        onClick={() => setOpen((o) => !o)}
      >
        <Captions aria-hidden="true" /> CC{subs.choice !== 'off' ? `: ${current}` : ''}
      </button>
      {open && (
        <div className="subs-menu__panel" role="group" aria-label="Subtitles">
          <ul className="subs-menu__list">
            {options.map((o) => (
              <li key={o.code}>
                <button
                  type="button"
                  className="subs-menu__option"
                  aria-pressed={subs.choice === o.code}
                  onClick={() => {
                    subs.choose(o.code)
                    setOpen(false)
                  }}
                >
                  {subs.choice === o.code ? <Check aria-hidden="true" /> : <span className="subs-menu__space" />}
                  {o.name}
                </button>
              </li>
            ))}
          </ul>
          {subs.choice !== 'off' && (
            <div className="subs-menu__sync">
              <button type="button" className="btn btn--ghost" onClick={() => subs.nudge(-SYNC_STEP_S)} aria-label="Subtitles 0.5 seconds earlier">
                −0.5s
              </button>
              <span className="subs-menu__offset" aria-live="polite">
                {subs.offset === 0 ? 'In sync' : `${sign}${Math.abs(subs.offset).toFixed(1)}s`}
              </span>
              <button type="button" className="btn btn--ghost" onClick={() => subs.nudge(SYNC_STEP_S)} aria-label="Subtitles 0.5 seconds later">
                +0.5s
              </button>
            </div>
          )}
        </div>
      )}
      {subs.status === 'none' && <span className="subs-menu__note">No subtitles found</span>}
      {subs.status === 'loading' && <span className="subs-menu__note">Loading subtitles…</span>}
    </div>
  )
}
