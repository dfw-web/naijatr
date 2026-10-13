import { createContext, useContext } from 'react'
import type { CatalogProvider } from '../types/media'
import { createFallbackProvider } from './fallbackProvider'
import { createLocalProvider } from './localProvider'
import { createTmdbProvider } from './tmdbProvider'

/**
 * `__TMDB_ENABLED__` is a build-time boolean set in vite.config.ts. It is only
 * true when TMDB credentials exist on the server side; the credentials
 * themselves are never included in the bundle.
 */
export const isTmdbEnabled = __TMDB_ENABLED__

/** TMDB when configured, falling back to the sample catalogue if TMDB is unavailable. */
export const defaultProvider: CatalogProvider = isTmdbEnabled
  ? createFallbackProvider(createTmdbProvider(), createLocalProvider())
  : createLocalProvider()

/** Lets tests (or a future settings screen) supply a different provider. */
export const CatalogProviderContext = createContext<CatalogProvider>(defaultProvider)

export const useCatalogProvider = () => useContext(CatalogProviderContext)
