import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Footer } from '../components/Footer'
import { GreetingHost } from '../components/Greeting'
import { Navbar } from '../components/Navbar'
import { hashForView, NAV_LINKS, type NavLink } from '../navigation'
import { errorMessage, fetchDrama, fetchShelves, searchDramas, type Drama, type DramaDetails, type Episode, type Shelf } from './api'
import { DramaPlayer } from './DramaPlayer'
import { EpisodePicker } from './EpisodePicker'
import { continueLabel, dramaEntryId, recordDramaProgress, recordDramaView, resumeSeconds, useDramaHistory } from './history'
import {
  DRAMA_PROVIDERS,
  DRAMAS_PATH,
  linkProps,
  pathForDrama,
  pathForProvider,
  PROVIDER_NAMES,
  routeFromLocation,
  type DramaProvider,
} from './format'
import './dramas.css'

type Go = (path: string, replace?: boolean) => void

/** Loads with cancellation; `reload` asks again. */
function useLoad<T>(load: (signal: AbortSignal) => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setState({ loading: true })
    load(controller.signal).then(
      (data) => setState({ data, loading: false }),
      (error: Error) => {
        if (error.name !== 'AbortError') setState({ error: errorMessage(error), loading: false })
      },
    )
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, attempt])
  return { ...state, reload: () => setAttempt((n) => n + 1) }
}

function Problem({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="dr-problem" role="alert">
      <p>{message}</p>
      <button type="button" className="dr-button" onClick={onRetry}>
        Try again
      </button>
    </div>
  )
}

function DramaCard({ drama, go }: { drama: Drama; go: Go }) {
  return (
    <a className="dr-card" {...linkProps(pathForDrama(drama.provider, drama.id), go)}>
      <span className="dr-card__poster">
        {drama.cover ? <img src={drama.cover} alt="" loading="lazy" referrerPolicy="no-referrer" /> : null}
        {drama.episodes ? <span className="dr-card__badge">{drama.episodes} eps</span> : null}
      </span>
      <span className="dr-card__title">{drama.title}</span>
      {drama.tags.length ? <span className="dr-card__tags">{drama.tags.slice(0, 2).join(' · ')}</span> : null}
    </a>
  )
}

function ProviderTabs({ active, go }: { active: DramaProvider; go: Go }) {
  return (
    <nav className="dr-tabs" aria-label="Drama apps">
      {DRAMA_PROVIDERS.map((provider) => (
        <a
          key={provider}
          className={`dr-tab${provider === active ? ' dr-tab--active' : ''}`}
          aria-current={provider === active ? 'page' : undefined}
          {...linkProps(pathForProvider(provider), go)}
        >
          {PROVIDER_NAMES[provider]}
        </a>
      ))}
    </nav>
  )
}

function SkeletonGrid() {
  return (
    <div className="dr-grid" aria-hidden="true">
      {Array.from({ length: 12 }, (_, i) => (
        <span key={i} className="dr-card dr-card--skeleton">
          <span className="dr-card__poster" />
        </span>
      ))}
    </div>
  )
}

function DramasHome({ provider, query, go }: { provider: DramaProvider; query: string; go: Go }) {
  const search = query.trim()
  const shelves = useLoad<Shelf[]>((signal) => fetchShelves(provider, signal), [provider])
  // Waits for typing to pause before searching.
  const [debounced, setDebounced] = useState(search)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search), 400)
    return () => window.clearTimeout(timer)
  }, [search])
  const results = useLoad<Drama[] | null>((signal) => (debounced.length >= 2 ? searchDramas(provider, debounced, signal) : Promise.resolve(null)), [provider, debounced])

  return (
    <div className="dr-page">
      <header className="dr-head">
        <h1 className="dr-head__title">Short Dramas</h1>
        <p className="dr-head__lead">Bite-size series in minutes-long episodes, from the top drama apps.</p>
      </header>
      <ProviderTabs active={provider} go={go} />

      {search.length >= 2 ? (
        <section className="dr-shelf" aria-live="polite">
          <h2 className="dr-shelf__title">Results for “{search}”</h2>
          {results.loading || debounced !== search ? (
            <SkeletonGrid />
          ) : results.error ? (
            <Problem message={results.error} onRetry={results.reload} />
          ) : results.data?.length ? (
            <div className="dr-grid">
              {results.data.map((drama) => (
                <DramaCard key={drama.id} drama={drama} go={go} />
              ))}
            </div>
          ) : (
            <p className="dr-muted">No {PROVIDER_NAMES[provider]} dramas match that. Try another word, or another app.</p>
          )}
        </section>
      ) : shelves.loading ? (
        <SkeletonGrid />
      ) : shelves.error ? (
        <Problem message={shelves.error} onRetry={shelves.reload} />
      ) : (
        shelves.data?.map((shelf) => (
          <section key={shelf.title} className="dr-shelf">
            <h2 className="dr-shelf__title">{shelf.title}</h2>
            <div className="dr-grid">
              {shelf.dramas.map((drama) => (
                <DramaCard key={drama.id} drama={drama} go={go} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  )
}

function DramaPage({ provider, id, ep, resume, go }: { provider: DramaProvider; id: string; ep: string | null; resume: boolean; go: Go }) {
  const details = useLoad<DramaDetails>((signal) => fetchDrama(provider, id, signal), [provider, id])
  const episodes = useMemo(() => details.data?.episodes ?? [], [details.data])
  const playable = useMemo(() => episodes.filter((e) => e.playable), [episodes])
  const current = ep ? (episodes.find((e) => e.id === ep && e.playable) ?? null) : null
  const index = current ? playable.indexOf(current) : -1
  const title = details.data?.drama?.title || details.data?.title || 'Drama'

  useEffect(() => {
    document.title = `${title} · Short Dramas · NAIJA TR`
  }, [title])

  // "Your short dramas" on the home page: opened now, so it's first.
  const loaded = details.data
  useEffect(() => {
    if (!loaded) return
    recordDramaView({
      provider,
      dramaId: id,
      title: loaded.drama?.title || loaded.title || '',
      poster: loaded.drama?.cover || null,
      episodeCount: loaded.episodes.length || loaded.drama?.episodes || null,
    })
  }, [loaded, provider, id])

  const open = useCallback((episode: Episode) => go(pathForDrama(provider, id, episode.id), Boolean(ep)), [go, provider, id, ep])
  const close = useCallback(() => go(pathForDrama(provider, id), true), [go, provider, id])

  // Where they stopped ("Your short dramas"): the episode watched here, else the one set on the picker.
  const entryId = dramaEntryId(provider, id)
  const saved = useDramaHistory().find((e) => e.id === entryId) ?? null
  const savedEpisode =
    saved && saved.episode !== null
      ? (episodes.find((e) => saved.episodeId !== null && e.id === saved.episodeId) ?? episodes.find((e) => e.number === saved.episode) ?? null)
      : null
  // "Continue Ep 12 · 3:45" from the home page (?resume=1): straight into the player, at that time.
  // Came here to resume (the address loses ?resume=1 once it's handled).
  const [cameToResume] = useState(resume)
  // Paid in the app: the page instead, saying so.
  const lockedResume = cameToResume && savedEpisode && !savedEpisode.playable ? savedEpisode.number : null
  const resumed = useRef(false)
  useEffect(() => {
    if (!resume || !loaded || resumed.current) return
    resumed.current = true
    go(savedEpisode?.playable ? pathForDrama(provider, id, savedEpisode.id) : pathForDrama(provider, id), true)
  }, [resume, loaded, savedEpisode, go, provider, id])

  if (details.loading) return <div className="dr-page"><SkeletonGrid /></div>
  if (details.error || !details.data) return <div className="dr-page"><Problem message={details.error ?? errorMessage(null)} onRetry={details.reload} /></div>

  const drama = details.data.drama
  // More than "Play episode 1": another episode, or a time to go back to.
  const canContinue = saved !== null && savedEpisode !== null && savedEpisode.playable && (savedEpisode !== playable[0] || resumeSeconds(saved) !== null)
  const lockedCount = episodes.filter((e) => !e.playable).length

  return (
    <div className="dr-page">
      <a className="dr-back" {...linkProps(pathForProvider(provider), go)}>
        ‹ {PROVIDER_NAMES[provider]}
      </a>
      <div className="dr-detail">
        {drama?.cover ? <img className="dr-detail__poster" src={drama.cover} alt="" referrerPolicy="no-referrer" /> : null}
        <div className="dr-detail__info">
          <h1 className="dr-detail__title">{title}</h1>
          <p className="dr-muted">
            {PROVIDER_NAMES[provider]} · {episodes.length} episodes
            {drama?.popularity ? ` · ${drama.popularity} views` : ''}
          </p>
          {drama?.tags.length ? (
            <ul className="dr-detail__tags">
              {drama.tags.map((tag) => (
                <li key={tag}>{tag}</li>
              ))}
            </ul>
          ) : null}
          {drama?.description ? <p className="dr-detail__desc">{drama.description}</p> : null}
          <EpisodePicker entryId={entryId} />
          {lockedResume !== null ? (
            <p className="dr-muted" role="status">
              🔒 Episode {lockedResume} is paid in the {PROVIDER_NAMES[provider]} app, so it can’t play here.
            </p>
          ) : null}
          <div className="dr-detail__actions">
            {canContinue ? (
              <button type="button" className="dr-button" onClick={() => open(savedEpisode)}>
                ▶ {continueLabel(saved)}
              </button>
            ) : null}
            {playable[0] ? (
              <button type="button" className={`dr-button${canContinue ? ' dr-button--ghost' : ''}`} onClick={() => open(playable[0])}>
                ▶ Play episode {playable[0].number}
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <section className="dr-shelf">
        <h2 className="dr-shelf__title">Episodes</h2>
        {lockedCount ? (
          <p className="dr-muted">
            🔒 {lockedCount} episodes are paid in the {PROVIDER_NAMES[provider]} app, so they can’t play here.
          </p>
        ) : null}
        <ol className="dr-episodes">
          {episodes.map((episode) => (
            <li key={episode.id}>
              <button
                type="button"
                className={`dr-ep${episode.playable ? '' : ' dr-ep--locked'}${episode === current ? ' dr-ep--current' : ''}`}
                disabled={!episode.playable}
                onClick={() => open(episode)}
                aria-label={`Episode ${episode.number}${episode.playable ? '' : ', locked'}`}
              >
                {episode.playable ? episode.number : '🔒'}
              </button>
            </li>
          ))}
        </ol>
      </section>

      {current ? (
        <DramaPlayer
          key={current.id}
          provider={provider}
          dramaId={id}
          title={title}
          episode={current}
          next={playable[index + 1] ?? null}
          previous={playable[index - 1] ?? null}
          onEpisode={open}
          onClose={close}
          startAt={saved?.episodeId === current.id ? resumeSeconds(saved) : null}
          onProgress={(position, duration) =>
            recordDramaProgress(entryId, { episode: current.number, episodeId: current.id, position, duration })
          }
        />
      ) : null}
    </div>
  )
}

/**
 * The Short Dramas section, served at /dramas, /dramas/{provider} and
 * /dramas/{provider}/{id}?ep={episode}. A separate root (picked in main.tsx),
 * like the Football section; links back to movies do a normal page load.
 */
export default function DramasApp() {
  const [route, setRoute] = useState(() => routeFromLocation(window.location.pathname, window.location.search))
  const [query, setQuery] = useState('')

  useEffect(() => {
    const onPopState = () => setRoute(routeFromLocation(window.location.pathname, window.location.search))
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    if (route.page === 'home') document.title = 'Short Dramas · NAIJA TR'
  }, [route])

  const go = useCallback<Go>((path, replace = false) => {
    const [pathname, search = ''] = path.split('?')
    if (window.location.pathname + window.location.search !== path) window.history[replace ? 'replaceState' : 'pushState'](null, '', path)
    const next = routeFromLocation(pathname, search ? `?${search}` : '')
    setRoute(next)
    // Opening or closing the player keeps the page where it is.
    if (next.page !== 'drama' || !next.ep) {
      if (!replace) window.scrollTo({ top: 0 })
    }
  }, [])

  const handleNavigate = (link: NavLink) => {
    if (link.href === DRAMAS_PATH) {
      setQuery('')
      return go(DRAMAS_PATH)
    }
    window.location.assign(link.href ?? `/${hashForView(link.view)}`)
  }

  // Typing in the navbar search looks for dramas on the current app.
  const handleQueryChange = (next: string) => {
    setQuery(next)
    if (next.trim() && route.page !== 'home') go(pathForProvider(route.provider))
  }

  return (
    <>
      <Navbar links={NAV_LINKS} activeId="dramas" query={query} onQueryChange={handleQueryChange} onNavigate={handleNavigate} />
      <main className="dr-main">
        {route.page === 'drama' ? (
          <DramaPage key={`${route.provider}:${route.id}`} provider={route.provider} id={route.id} ep={route.ep} resume={route.resume} go={go} />
        ) : (
          <DramasHome provider={route.provider} query={query} go={go} />
        )}
      </main>
      <Footer links={NAV_LINKS} onNavigate={handleNavigate} onBackToTop={() => window.scrollTo({ top: 0, behavior: 'smooth' })} />
      <GreetingHost />
    </>
  )
}
