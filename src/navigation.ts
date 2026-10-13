export type View = 'home' | 'movies' | 'series'

export interface NavLink {
  id: string
  label: string
  view: View
  /** Homepage section to scroll to after navigating. */
  section?: string
}

export const NAV_LINKS: NavLink[] = [
  { id: 'home', label: 'Home', view: 'home' },
  { id: 'movies', label: 'Movies', view: 'movies' },
  { id: 'series', label: 'Series', view: 'series' },
  { id: 'recent', label: 'New & Recent', view: 'home', section: 'recent' },
]

/** Views live in the URL hash (#/movies, #/series) so Back and deep links work. */
export const viewFromHash = (hash: string): View =>
  hash === '#/movies' ? 'movies' : hash === '#/series' ? 'series' : 'home'

export const hashForView = (view: View) => (view === 'home' ? '' : `#/${view}`)
