import type { MouseEvent } from 'react'

/** The Short Dramas section's pages, all under /dramas. */
export const DRAMAS_PATH = '/dramas'

export const DRAMA_PROVIDERS = ['dramabox', 'dramawave', 'netshort'] as const
export type DramaProvider = (typeof DRAMA_PROVIDERS)[number]

export const PROVIDER_NAMES: Record<DramaProvider, string> = {
  dramabox: 'DramaBox',
  dramawave: 'DramaWave',
  netshort: 'NetShort',
}

/** The app's name, e.g. "DramaBox" (one we don't list: its id, capitalised). */
export const providerLabel = (provider: string) =>
  PROVIDER_NAMES[provider as DramaProvider] ?? provider.charAt(0).toUpperCase() + provider.slice(1)

export const isProvider = (value: string | null | undefined): value is DramaProvider =>
  DRAMA_PROVIDERS.includes(value as DramaProvider)

export type DramasRoute =
  | { page: 'home'; provider: DramaProvider }
  /** `resume`: carry on at the episode and time saved in "Your short dramas" (history.ts). */
  | { page: 'drama'; provider: DramaProvider; id: string; ep: string | null; resume: boolean }

// Ids as on the server (server/dramas/providers.ts ID): DramaBox's are name slugs.
const DRAMA_PATH = /^\/dramas\/([a-z]+)\/([A-Za-z0-9_-]{1,100})\/?$/
const HOME_PATH = /^\/dramas(?:\/([a-z]+))?\/?$/

export const isDramasPath = (pathname: string) => pathname === DRAMAS_PATH || pathname.startsWith(`${DRAMAS_PATH}/`)

export function routeFromLocation(pathname: string, search = ''): DramasRoute {
  const drama = DRAMA_PATH.exec(pathname)
  if (drama && isProvider(drama[1])) {
    const params = new URLSearchParams(search)
    return { page: 'drama', provider: drama[1], id: drama[2], ep: params.get('ep'), resume: params.has('resume') }
  }
  const home = HOME_PATH.exec(pathname)
  return { page: 'home', provider: home && isProvider(home[1]) ? home[1] : 'dramabox' }
}

export const pathForProvider = (provider: DramaProvider) => (provider === 'dramabox' ? DRAMAS_PATH : `${DRAMAS_PATH}/${provider}`)

export const pathForDrama = (provider: DramaProvider, id: string, ep?: string) =>
  `${DRAMAS_PATH}/${provider}/${id}${ep ? `?ep=${encodeURIComponent(ep)}` : ''}`

/** The home page's "Continue Ep 12 · 3:45": the drama's page, carrying on where they stopped. */
export const resumePath = (provider: DramaProvider, id: string) => `${DRAMAS_PATH}/${provider}/${id}?resume=1`

/** Opens in-app on a plain click; still a real link for new tabs and sharing. */
export function linkProps(path: string, go: (path: string) => void) {
  return {
    href: path,
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      go(path)
    },
  }
}
