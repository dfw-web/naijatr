/**
 * NextStream playback, resolved on the Vite dev/preview server only.
 *
 * The provider's URL patterns are NOT hard-coded: copy them from the NextStream
 * documentation into `.env.local` (see .env.example). Templates may use the
 * placeholders {tmdbId}, {season}, {episode} and {apiKey}.
 */
export interface NextStreamConfig {
  apiKey: string
  movieTemplate: string
  tvTemplate: string
  /** Optional: where your server serves the downloadable file for a title. */
  movieDownloadTemplate: string
  tvDownloadTemplate: string
}

export type PlaybackRequest =
  | { kind: 'movie'; tmdbId: string }
  | { kind: 'tv'; tmdbId: string; season: string; episode: string }

const POSITIVE_INT = /^[1-9]\d{0,8}$/

export function readNextStreamConfig(env: Record<string, string | undefined>): NextStreamConfig {
  return {
    apiKey: env.NEXTSTREAM_API_KEY?.trim() ?? '',
    movieTemplate: env.NEXTSTREAM_MOVIE_URL?.trim() ?? '',
    tvTemplate: env.NEXTSTREAM_TV_URL?.trim() ?? '',
    movieDownloadTemplate: env.NEXTSTREAM_MOVIE_DOWNLOAD_URL?.trim() ?? '',
    tvDownloadTemplate: env.NEXTSTREAM_TV_DOWNLOAD_URL?.trim() ?? '',
  }
}

/** Parses `/movie/{id}` or `/tv/{id}/{season}/{episode}`; null for anything else. */
export function parsePlaybackPath(path: string): PlaybackRequest | null {
  const parts = path.split('?')[0].split('/').filter(Boolean)
  if (parts[0] === 'movie' && parts.length === 2 && POSITIVE_INT.test(parts[1])) {
    return { kind: 'movie', tmdbId: parts[1] }
  }
  if (parts[0] === 'tv' && parts.length === 4 && parts.slice(1).every((p) => POSITIVE_INT.test(p))) {
    return { kind: 'tv', tmdbId: parts[1], season: parts[2], episode: parts[3] }
  }
  return null
}

/** Fills the matching template. Returns null when that template is not configured or invalid. */
export function resolvePlaybackUrl(config: NextStreamConfig, request: PlaybackRequest): string | null {
  const template = request.kind === 'movie' ? config.movieTemplate : config.tvTemplate
  if (!template) return null
  if (template.includes('{apiKey}') && !config.apiKey) return null
  if (request.kind === 'tv' && !(template.includes('{season}') && template.includes('{episode}'))) {
    return null
  }
  const values: Record<string, string> = {
    tmdbId: request.tmdbId,
    season: request.kind === 'tv' ? request.season : '',
    episode: request.kind === 'tv' ? request.episode : '',
    apiKey: config.apiKey,
  }
  const url = template.replace(/\{(tmdbId|season|episode|apiKey)\}/g, (_, name: string) =>
    encodeURIComponent(values[name]),
  )
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? url : null
  } catch {
    return null
  }
}

export const isPlaybackConfigured = (config: NextStreamConfig) => ({
  movie: resolvePlaybackUrl(config, { kind: 'movie', tmdbId: '1' }) !== null,
  tv: resolvePlaybackUrl(config, { kind: 'tv', tmdbId: '1', season: '1', episode: '1' }) !== null,
})

/** Same as resolvePlaybackUrl, using the download templates. */
export const resolveDownloadUrl = (config: NextStreamConfig, request: PlaybackRequest) =>
  resolvePlaybackUrl(
    { ...config, movieTemplate: config.movieDownloadTemplate, tvTemplate: config.tvDownloadTemplate },
    request,
  )

export const isDownloadConfigured = (config: NextStreamConfig) => ({
  movie: resolveDownloadUrl(config, { kind: 'movie', tmdbId: '1' }) !== null,
  tv: resolveDownloadUrl(config, { kind: 'tv', tmdbId: '1', season: '1', episode: '1' }) !== null,
})
