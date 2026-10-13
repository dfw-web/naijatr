import { describe, expect, it } from 'vitest'
import {
  isPlaybackConfigured,
  parsePlaybackPath,
  readNextStreamConfig,
  resolvePlaybackUrl,
} from './nextstream'

const config = readNextStreamConfig({
  NEXTSTREAM_API_KEY: 'nx_test',
  NEXTSTREAM_MOVIE_URL: 'https://player.example/movie/{tmdbId}?key={apiKey}',
  NEXTSTREAM_TV_URL: 'https://player.example/tv/{tmdbId}/{season}/{episode}?key={apiKey}',
})

describe('NextStream playback resolver', () => {
  it('parses movie and episode paths and rejects anything else', () => {
    expect(parsePlaybackPath('/movie/550')).toEqual({ kind: 'movie', tmdbId: '550' })
    expect(parsePlaybackPath('/tv/1399/2/5?check=1')).toEqual({
      kind: 'tv',
      tmdbId: '1399',
      season: '2',
      episode: '5',
    })
    for (const bad of ['/movie/abc', '/movie/0', '/tv/1399/1', '/tv/1/x/1', '/movie/1/2', '/']) {
      expect(parsePlaybackPath(bad)).toBeNull()
    }
  })

  it('fills the movie and TV templates', () => {
    expect(resolvePlaybackUrl(config, { kind: 'movie', tmdbId: '550' })).toBe(
      'https://player.example/movie/550?key=nx_test',
    )
    expect(
      resolvePlaybackUrl(config, { kind: 'tv', tmdbId: '1399', season: '2', episode: '5' }),
    ).toBe('https://player.example/tv/1399/2/5?key=nx_test')
  })

  it('reports nothing configured when templates are missing', () => {
    const empty = readNextStreamConfig({ NEXTSTREAM_API_KEY: 'nx_test' })
    expect(isPlaybackConfigured(empty)).toEqual({ movie: false, tv: false })
    expect(isPlaybackConfigured(config)).toEqual({ movie: true, tv: true })
  })

  it('rejects templates that need a missing key or lack season/episode', () => {
    const noKey = readNextStreamConfig({ NEXTSTREAM_MOVIE_URL: 'https://p.example/{tmdbId}?k={apiKey}' })
    expect(isPlaybackConfigured(noKey).movie).toBe(false)
    const noEpisode = readNextStreamConfig({ NEXTSTREAM_TV_URL: 'https://p.example/tv/{tmdbId}' })
    expect(isPlaybackConfigured(noEpisode).tv).toBe(false)
    const notHttp = readNextStreamConfig({ NEXTSTREAM_MOVIE_URL: 'javascript:alert({tmdbId})' })
    expect(isPlaybackConfigured(notHttp).movie).toBe(false)
  })
})
