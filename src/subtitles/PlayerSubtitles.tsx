import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import { Captions, Check } from 'lucide-react'
import { isIos } from '../pwa'
import {
  cuesAt,
  DEFAULT_LANG,
  loadLanguages,
  loadSubtitle,
  loadVersions,
  offsetKey,
  reportOutOfSync,
  savedOffset,
  savedSpeed,
  savedVersion,
  saveSubtitleOffset,
  saveSubtitleSpeed,
  saveSubtitleVersion,
  setSubtitleChoice,
  SPEEDS,
  subscribeSubtitleChoice,
  subtitleChoice,
  subtitleTime,
  takeIphoneTip,
  versionKey,
  voteSync,
  type Cue,
  type LoadedSubtitle,
  type SpeedId,
  type SubtitleLanguage,
  type SubtitleTarget,
  type SubtitleVersion,
} from './subtitles'
import './PlayerSubtitles.css'

/**
 * Our own subtitles over the player (neither server's player takes a subtitle
 * from outside). The text follows the time the player posts to the page
 * (`{ source: 'embedmaster_player', event: 'time', info: seconds }`), so the CC
 * button only shows once a player has reported its time. Nothing is fetched
 * until the video is playing: subtitles never hold up playback.
 *
 * Sync: another version of the file, an offset (±0.5s / ±5s, per title) and a
 * speed (frame-rate stretch, per title). A setting the viewer changed and then
 * kept for VOTE_AFTER_MS of watching counts as one vote for the episode's
 * community default (3 viewers on the same one: everyone gets it).
 */

const PLAYER_EVENTS = 'embedmaster_player'
/** Between time events, the clock runs on by itself (while playing), at most this far. */
const MAX_COAST_S = 1.5
const TICK_MS = 100
export const SYNC_STEP_S = 0.5
export const BIG_SYNC_STEP_S = 5
/** A changed setting kept this long while watching "works". */
export const VOTE_AFTER_MS = 2 * 60 * 1000

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

/** "+2.5s", "−0.5s", "0.0s". */
export const formatOffset = (offset: number) => `${offset > 0 ? '+' : offset < 0 ? '−' : ''}${Math.abs(offset).toFixed(1)}s`

export interface PlayerSubtitles {
  /** The player reports its time: the CC button can show. */
  supported: boolean
  choice: string
  status: Status
  languages: SubtitleLanguage[]
  offset: number
  speed: SpeedId
  /** The community's offset and speed are in use (the viewer hasn't set their own). */
  community: boolean
  /** The file showing, and the others ("Try another version"); null until asked for. */
  version: string | null
  versions: SubtitleVersion[] | null
  reported: boolean
  shown: Cue[]
  iphoneTip: boolean
  choose: (choice: string) => void
  nudge: (by: number) => void
  resetSync: () => void
  setSpeed: (speed: SpeedId) => void
  chooseVersion: (id: string) => void
  wantVersions: () => void
  report: () => void
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
  const titleKey = target ? offsetKey(target) : null
  const episodeKey = target && choice !== 'off' ? versionKey(target, choice) : null

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

  // The version the viewer picked for this episode (null: the best one, or the community's).
  const [pickedVersion, setPickedVersion] = useState<string | null>(null)
  useEffect(() => setPickedVersion(episodeKey ? savedVersion(episodeKey) : null), [episodeKey])

  // The subtitle itself. Each version stays in memory, so switching back is instant.
  const loadedRef = useRef(new Map<string, LoadedSubtitle | null>())
  const [, setLoadedTick] = useState(0)
  const loadKey = active && episodeKey ? `${episodeKey}:${pickedVersion ?? 'auto'}` : null
  useEffect(() => {
    if (!loadKey || !target || loadedRef.current.has(loadKey)) return
    const ctrl = new AbortController()
    void loadSubtitle(target, choice, pickedVersion, ctrl.signal).then((sub) => {
      if (ctrl.signal.aborted) return
      loadedRef.current.set(loadKey, sub)
      setLoadedTick((n) => n + 1)
    })
    return () => ctrl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey])
  const loaded = loadKey && loadedRef.current.has(loadKey) ? loadedRef.current.get(loadKey)! : undefined
  const status: Status = choice === 'off' || !active ? 'off' : loaded === undefined ? 'loading' : loaded ? 'ready' : 'none'

  // Offset and speed, per title: the viewer's own, else the community's for this episode, else none.
  const [own, setOwn] = useState<{ offset: number | null; speed: SpeedId | null }>({ offset: null, speed: null })
  useEffect(() => setOwn(titleKey ? { offset: savedOffset(titleKey), speed: savedSpeed(titleKey) } : { offset: null, speed: null }), [titleKey])
  const communitySetting = !pickedVersion ? (loaded?.community ?? null) : null
  const offset = own.offset ?? communitySetting?.offset ?? 0
  const speed = own.speed ?? communitySetting?.speed ?? '1'
  const community = communitySetting !== null && own.offset === null && own.speed === null
  const version = loaded?.version ?? pickedVersion

  // A change the viewer made, then kept while watching: one vote (once per setting and episode).
  const [changed, setChanged] = useState(0)
  const voted = useRef(new Set<string>())
  useEffect(() => {
    if (!changed || status !== 'ready' || !target || !version || choice === 'off') return
    const setting = { version, offset, speed }
    const signature = `${targetKey}:${choice}:${version}:${offset}:${speed}`
    if (voted.current.has(signature)) return
    const timer = window.setTimeout(() => {
      if (!clock.current.playing) return
      voted.current.add(signature)
      void voteSync(target, choice, setting)
    }, VOTE_AFTER_MS)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changed, status, version, offset, speed, choice, targetKey])

  const nudge = (by: number) => {
    const next = Math.round((offset + by) * 10) / 10
    setOwn((o) => ({ ...o, offset: next, speed: o.speed ?? speed }))
    if (titleKey) {
      saveSubtitleOffset(titleKey, next)
      saveSubtitleSpeed(titleKey, own.speed ?? speed)
    }
    setChanged((n) => n + 1)
  }
  const resetSync = () => {
    setOwn({ offset: 0, speed: '1' })
    if (titleKey) {
      saveSubtitleOffset(titleKey, 0)
      saveSubtitleSpeed(titleKey, '1')
    }
    setChanged((n) => n + 1)
  }
  const setSpeed = (next: SpeedId) => {
    setOwn((o) => ({ offset: o.offset ?? offset, speed: next }))
    if (titleKey) {
      saveSubtitleSpeed(titleKey, next)
      saveSubtitleOffset(titleKey, own.offset ?? offset)
    }
    setChanged((n) => n + 1)
  }
  const chooseVersion = (id: string) => {
    setPickedVersion(id)
    if (episodeKey) saveSubtitleVersion(episodeKey, id)
    setChanged((n) => n + 1)
  }

  // "Try another version": asked for when the menu opens, per episode and language.
  const [versionsFor, setVersionsFor] = useState<{ key: string; list: SubtitleVersion[] } | null>(null)
  const [wanted, setWanted] = useState(false)
  useEffect(() => {
    if (!wanted || !active || !target || !episodeKey || versionsFor?.key === episodeKey) return
    const ctrl = new AbortController()
    const key = episodeKey
    void loadVersions(target, choice, ctrl.signal).then((list) => !ctrl.signal.aborted && setVersionsFor({ key, list }))
    return () => ctrl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, active, episodeKey])
  const versions = versionsFor?.key === episodeKey ? versionsFor.list : null

  // "Subtitles out of sync?": once per episode and language.
  const [reportedFor, setReportedFor] = useState<string | null>(null)
  const report = () => {
    if (!target || !episodeKey || reportedFor === episodeKey) return
    setReportedFor(episodeKey)
    void reportOutOfSync(target, choice, { version: version ?? undefined, offset, speed })
  }

  // iPhone: the player's own fullscreen is the video alone, without our text. Said once.
  const [iphoneTip, setIphoneTip] = useState(false)
  useEffect(() => {
    if (status !== 'ready' || !isIos() || !takeIphoneTip()) return
    setIphoneTip(true)
    const timer = window.setTimeout(() => setIphoneTip(false), 7000)
    return () => window.clearTimeout(timer)
  }, [status])

  const shown = status === 'ready' && loaded ? cuesAt(loaded.cues, subtitleTime(time, offset, speed)) : []
  return {
    supported: active,
    choice,
    status,
    languages,
    offset,
    speed,
    community,
    version,
    versions,
    reported: reportedFor !== null && reportedFor === episodeKey,
    shown,
    iphoneTip,
    choose: (c) => setSubtitleChoice(c),
    nudge,
    resetSync,
    setSpeed,
    chooseVersion,
    wantVersions: () => setWanted(true),
    report,
  }
}

/** <i>, <b> and <u> stay; any other markup shows as text. */
function CueLine({ line }: { line: string }) {
  const parts = line.split(/(<\/?[ibu]>)/i)
  const out: ReactNode[] = []
  const style = { i: false, b: false, u: false }
  parts.forEach((part, n) => {
    const tag = /^<(\/)?([ibu])>$/i.exec(part)
    if (tag) {
      style[tag[2].toLowerCase() as 'i' | 'b' | 'u'] = !tag[1]
      return
    }
    if (!part) return
    let node: ReactNode = part.replace(/<[^>]*>/g, '')
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

/** The CC button (in the player's bar) and its menu: languages, sync, speed, versions and "out of sync?". */
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
  const { wantVersions, choice } = subs
  useEffect(() => {
    if (open && choice !== 'off') wantVersions()
    // wantVersions only sets a flag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, choice])
  if (!subs.supported) return null

  const others = subs.languages.filter((l) => l.code !== 'en' && l.available)
  const options = [
    { code: 'off', name: 'Off' },
    { code: 'en', name: 'English' },
    ...others.map((l) => ({ code: l.code, name: l.name })),
  ]
  const current = options.find((o) => o.code === subs.choice)?.name ?? subs.choice
  const on = subs.choice !== 'off'

  return (
    <div className="subs-menu" ref={boxRef}>
      <button
        type="button"
        className="btn btn--ghost subs-menu__button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-pressed={on}
        onClick={() => setOpen((o) => !o)}
      >
        <Captions aria-hidden="true" /> CC{on ? `: ${current}` : ''}
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
                    if (o.code === 'off') setOpen(false)
                  }}
                >
                  {subs.choice === o.code ? <Check aria-hidden="true" /> : <span className="subs-menu__space" />}
                  {o.name}
                </button>
              </li>
            ))}
          </ul>

          {on && (
            <>
              <p className="subs-menu__heading">
                Sync <span className="subs-menu__offset" aria-live="polite">{formatOffset(subs.offset)}</span>
                {subs.community && <span className="subs-menu__badge">Fixed by viewers</span>}
              </p>
              <div className="subs-menu__sync">
                <button type="button" className="btn btn--ghost" onClick={() => subs.nudge(-BIG_SYNC_STEP_S)} aria-label="Subtitles 5 seconds earlier">
                  −5s
                </button>
                <button type="button" className="btn btn--ghost" onClick={() => subs.nudge(-SYNC_STEP_S)} aria-label="Subtitles 0.5 seconds earlier">
                  −0.5s
                </button>
                <button type="button" className="btn btn--ghost" onClick={() => subs.nudge(SYNC_STEP_S)} aria-label="Subtitles 0.5 seconds later">
                  +0.5s
                </button>
                <button type="button" className="btn btn--ghost" onClick={() => subs.nudge(BIG_SYNC_STEP_S)} aria-label="Subtitles 5 seconds later">
                  +5s
                </button>
              </div>
              <button type="button" className="btn btn--ghost subs-menu__reset" onClick={subs.resetSync} disabled={subs.offset === 0 && subs.speed === '1'}>
                Reset
              </button>

              <label className="subs-menu__heading" htmlFor="subs-speed">
                Subtitle speed
              </label>
              <select id="subs-speed" className="subs-menu__select" value={subs.speed} onChange={(e) => subs.setSpeed(e.target.value as SpeedId)}>
                {SPEEDS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
              <p className="subs-menu__hint">For subtitles that drift further off as the video goes on.</p>

              <p className="subs-menu__heading">Try another version</p>
              {subs.versions === null ? (
                <p className="subs-menu__hint">Looking for other versions…</p>
              ) : subs.versions.length <= 1 ? (
                <p className="subs-menu__hint">No other versions found.</p>
              ) : (
                <ul className="subs-menu__list">
                  {subs.versions.map((v) => (
                    <li key={v.id}>
                      <button
                        type="button"
                        className="subs-menu__option"
                        aria-pressed={subs.version === v.id}
                        title={v.release || undefined}
                        onClick={() => subs.chooseVersion(v.id)}
                      >
                        {subs.version === v.id ? <Check aria-hidden="true" /> : <span className="subs-menu__space" />}
                        {v.label}
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <button type="button" className="btn btn--ghost subs-menu__report" onClick={subs.report} disabled={subs.reported}>
                {subs.reported ? 'Thanks, we’ll look at it' : 'Subtitles out of sync?'}
              </button>
            </>
          )}
        </div>
      )}
      {subs.status === 'none' && <span className="subs-menu__note">No subtitles found</span>}
      {subs.status === 'loading' && <span className="subs-menu__note">Loading subtitles…</span>}
    </div>
  )
}
