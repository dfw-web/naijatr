import { useEffect, useState } from 'react'
import { Footer } from '../components/Footer'
import { Navbar } from '../components/Navbar'
import { hashForView, NAV_LINKS, type NavLink } from '../navigation'
import { FOOTBALL_PATH, pathForMatch, routeFromPath } from './format'
import { FootballHome } from './FootballHome'
import { MatchDetails } from './MatchDetails'
import './football.css'

/**
 * The Football section, served at /football and /football/match/{id}. It is
 * a separate root (picked in main.tsx), so the movie app is never involved;
 * links back to movies and series do a normal page load.
 */
export default function FootballApp() {
  const [route, setRoute] = useState(() => routeFromPath(window.location.pathname))
  const [query, setQuery] = useState('')

  useEffect(() => {
    const onPopState = () => setRoute(routeFromPath(window.location.pathname))
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    document.title = route.page === 'match' ? 'Match · Football · NAIJA TR' : 'Football · NAIJA TR'
  }, [route])

  const go = (path: string) => {
    if (window.location.pathname + window.location.search !== path) window.history.pushState(null, '', path)
    setRoute(routeFromPath(path.split('?')[0]))
    window.scrollTo({ top: 0 })
  }

  const handleNavigate = (link: NavLink) => {
    if (link.href === FOOTBALL_PATH) {
      setQuery('')
      return go(FOOTBALL_PATH)
    }
    window.location.assign(`/${hashForView(link.view)}`)
  }

  // Typing in the navbar search filters matches by team or league.
  const handleQueryChange = (next: string) => {
    setQuery(next)
    if (next.trim() && route.page !== 'home') go(FOOTBALL_PATH)
  }

  return (
    <>
      <Navbar
        links={NAV_LINKS}
        activeId="football"
        query={query}
        onQueryChange={handleQueryChange}
        onNavigate={handleNavigate}
      />

      <main className="fb-main">
        {route.page === 'match' ? (
          <MatchDetails key={route.id} id={route.id} onBack={() => go(FOOTBALL_PATH)} />
        ) : (
          <FootballHome query={query} onOpenMatch={(id, tab) => go(pathForMatch(id, tab))} />
        )}
      </main>

      <Footer
        links={NAV_LINKS}
        onNavigate={handleNavigate}
        onBackToTop={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      />
    </>
  )
}
