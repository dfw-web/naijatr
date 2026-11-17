import type { DramaProvider } from './format'

/** Shapes from /api/dramas/* (server/dramas/handlers.ts). */
export interface Drama {
  provider: DramaProvider
  id: string
  title: string
  cover: string
  description: string
  tags: string[]
  episodes: number | null
  popularity: string | null
}

export interface Shelf {
  title: string
  dramas: Drama[]
}

export interface Episode {
  id: string
  number: number
  title: string
  /** Paid in the provider's own app. */
  locked: boolean
  /** Whether /play gives it a video link (paid ones only while the admin switch is on). */
  playable: boolean
}

export interface DramaDetails {
  drama: Drama | null
  title: string
  episodes: Episode[]
}

export interface VideoSource {
  url: string
  type: 'mp4' | 'hls'
  quality: string
  /** H.265: many desktop browsers can't play it. */
  codec?: 'hevc'
}

export class DramaApiError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.code = code
  }
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api/dramas/${path}`, { signal })
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error
    throw new DramaApiError('offline')
  }
  const body = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) throw new DramaApiError(body.error ?? 'upstream-error')
  return body
}

const q = (params: Record<string, string>) => new URLSearchParams(params).toString()

export const fetchShelves = (provider: DramaProvider, signal?: AbortSignal) =>
  get<{ shelves: Shelf[] }>(`home?${q({ provider })}`, signal).then((body) => body.shelves)

export const searchDramas = (provider: DramaProvider, query: string, signal?: AbortSignal) =>
  get<{ dramas: Drama[] }>(`search?${q({ provider, q: query })}`, signal).then((body) => body.dramas)

export const fetchDrama = (provider: DramaProvider, id: string, signal?: AbortSignal) =>
  get<DramaDetails>(`drama?${q({ provider, id })}`, signal)

export const fetchSources = (provider: DramaProvider, id: string, ep: string, signal?: AbortSignal) =>
  get<{ sources: VideoSource[] }>(`play?${q({ provider, id, ep })}`, signal).then((body) => body.sources)

export function errorMessage(error: unknown): string {
  const code = error instanceof DramaApiError ? error.code : ''
  if (code === 'not-configured') return 'Short dramas aren’t set up yet.'
  if (code === 'offline') return 'You seem to be offline. Check your connection and try again.'
  if (code === 'locked') return 'This episode is paid in the app, so it can’t play here.'
  if (code === 'no-source') return 'This episode has no video right now.'
  return 'This provider isn’t answering right now. Try again in a minute, or pick another one.'
}
