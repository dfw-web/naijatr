import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SubtitleMenu, SubtitleOverlay, usePlayerSubtitles } from './PlayerSubtitles'
import { cuesAt, parseVtt, saveSubtitleOffset, setSubtitleChoice, subtitleChoice, subtitleOffset, subtitleTime, type SubtitleTarget } from './subtitles'

const V2 = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nOther version\n'
const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello <i>there</i>\n\n00:00:05.000 --> 00:00:06.000\nSecond line\nand more\n'

describe('cues', () => {
  it('are read from WebVTT and found by time', () => {
    const cues = parseVtt(VTT)
    expect(cues).toHaveLength(2)
    expect(cuesAt(cues, 2)[0].lines).toEqual(['Hello <i>there</i>'])
    expect(cuesAt(cues, 4)).toEqual([])
    expect(cuesAt(cues, 5.5)[0].lines).toEqual(['Second line', 'and more'])
  })

  it('keep their language choice and a sync offset per title', () => {
    setSubtitleChoice('fr', false)
    expect(subtitleChoice()).toBe('fr')
    saveSubtitleOffset('movie:550', -1.5)
    expect(subtitleOffset('movie:550')).toBe(-1.5)
    expect(subtitleOffset('movie:551')).toBe(0)
  })

  it('stretch with the speed: 23.976 → 25 shows a cue timed at 100s at 95.9s', () => {
    expect(subtitleTime(95.904, 0, '23.976-25')).toBeCloseTo(100, 2)
    expect(subtitleTime(10, 2, '1')).toBe(8)
  })
})

const TARGET: SubtitleTarget = { tmdbId: 550, type: 'movie' }

function Player({ target = TARGET }: { target?: SubtitleTarget | null }) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const subs = usePlayerSubtitles(target, frameRef, target ? 'p1' : null)
  return (
    <div>
      <iframe ref={frameRef} title="player" />
      <SubtitleOverlay subs={subs} />
      <SubtitleMenu subs={subs} />
    </div>
  )
}

/** The player posting its time, from inside its iframe. */
function playerTime(seconds: number) {
  const frame = screen.getByTitle('player') as HTMLIFrameElement
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { source: 'embedmaster_player', event: 'time', info: seconds }, source: frame.contentWindow }))
  })
}

function playerEvent(event: string) {
  const frame = screen.getByTitle('player') as HTMLIFrameElement
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { source: 'embedmaster_player', event }, source: frame.contentWindow }))
  })
}

describe('the player overlay', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    localStorage.clear()
    setSubtitleChoice('en', false)
    fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('/api/subtitles/languages')) {
        return new Response(JSON.stringify({ languages: [{ code: 'en', name: 'English', available: true }, { code: 'fr', name: 'French', available: true }] }))
      }
      if (url.startsWith('/api/subtitles/versions')) {
        return new Response(
          JSON.stringify({
            versions: [
              { id: 'os:1', label: 'Version 1 (BluRay)', release: 'x' },
              { id: 'sd:/subtitle/2-3.zip', label: 'Version 2 (WEB-DL)', release: 'y' },
            ],
          }),
        )
      }
      if (url.startsWith('/api/subtitles/vote') || url.startsWith('/api/subtitles/report')) return new Response('{"ok":true}')
      if (url.includes('version=sd')) return new Response(V2, { headers: { 'X-Subtitle-Version': 'sd:/subtitle/2-3.zip' } })
      if (url.includes('tmdbId=600')) {
        return new Response(VTT, { headers: { 'X-Subtitle-Version': 'os:1', 'X-Subtitle-Community': '1', 'X-Subtitle-Offset': '2.5', 'X-Subtitle-Speed': '1' } })
      }
      if (url.includes('lang=en')) return new Response(VTT, { headers: { 'X-Subtitle-Version': 'os:1' } })
      return new Response(JSON.stringify({ error: 'not-found' }), { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('has no CC button (and fetches nothing) until the player reports its time', async () => {
    render(<Player />)
    expect(screen.queryByRole('button', { name: /CC/ })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    playerTime(0.5)
    expect(await screen.findByRole('button', { name: /CC: English/ })).toBeInTheDocument()
  })

  it('shows English by default, in time with the player', async () => {
    render(<Player />)
    playerTime(1.2)
    await waitFor(() => expect(screen.getByText('there')).toBeInTheDocument())
    expect(screen.getByText('there').tagName).toBe('I')
    playerTime(4)
    await waitFor(() => expect(screen.queryByText('there')).toBeNull())
  })

  it('moves the text with −0.5s / +0.5s, remembered for the title', async () => {
    render(<Player />)
    playerTime(3.2)
    await screen.findByRole('button', { name: /CC: English/ })
    await userEvent.click(screen.getByRole('button', { name: /CC: English/ }))
    // At 3.2s nothing shows; half a second later (+0.5s), "Hello" (1-3s) still shows at 3.2.
    await userEvent.click(screen.getByRole('button', { name: 'Subtitles 0.5 seconds later' }))
    expect(document.querySelector('.subs-menu__offset')).toHaveTextContent('+0.5s')
    expect(subtitleOffset('movie:550')).toBe(0.5)
    playerTime(3.2)
    await waitFor(() => expect(screen.getByText('there')).toBeInTheDocument())
  })

  it('offers Off, English and the other languages; "No subtitles found" quietly when there are none', async () => {
    render(<Player />)
    playerTime(1)
    await userEvent.click(await screen.findByRole('button', { name: /CC/ }))
    expect(await screen.findByRole('button', { name: 'French' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'French' }))
    expect(subtitleChoice()).toBe('fr')
    expect(await screen.findByText('No subtitles found')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Off' }))
    expect(subtitleChoice()).toBe('off')
    expect(screen.queryByText('No subtitles found')).toBeNull()
  })

  const openMenu = async () => {
    await userEvent.click(await screen.findByRole('button', { name: /CC/ }))
  }

  it('has −5s, −0.5s, +0.5s, +5s and Reset, with the offset shown', async () => {
    render(<Player />)
    playerTime(1)
    await openMenu()
    const offset = () => document.querySelector('.subs-menu__offset')
    expect(offset()).toHaveTextContent('0.0s')
    await userEvent.click(screen.getByRole('button', { name: 'Subtitles 5 seconds later' }))
    await userEvent.click(screen.getByRole('button', { name: 'Subtitles 5 seconds later' }))
    await userEvent.click(screen.getByRole('button', { name: 'Subtitles 0.5 seconds earlier' }))
    expect(offset()).toHaveTextContent('+9.5s')
    await userEvent.click(screen.getByRole('button', { name: 'Subtitles 5 seconds earlier' }))
    expect(offset()).toHaveTextContent('+4.5s')
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(offset()).toHaveTextContent('0.0s')
    expect(subtitleOffset('movie:550')).toBe(0)
  })

  it('stretches the timing with "Subtitle speed", kept for the title', async () => {
    render(<Player />)
    playerTime(1)
    await openMenu()
    await userEvent.selectOptions(screen.getByLabelText('Subtitle speed'), '25-24')
    expect(localStorage.getItem('naijatr.subs.speeds')).toContain('25-24')
    // "Hello" ends at 3s in the file; at 25 → 24 it's stretched to 3.125s, so at 3.05s (paused) it's still up.
    playerTime(3.05)
    playerEvent('pause')
    await waitFor(() => expect(screen.getByText('there')).toBeInTheDocument())
    await userEvent.selectOptions(screen.getByLabelText('Subtitle speed'), '1')
    await waitFor(() => expect(screen.queryByText('there')).toBeNull())
  })

  it('"Try another version" lists the files and switches at once, remembered for the episode', async () => {
    render(<Player />)
    playerTime(1.5)
    await waitFor(() => expect(screen.getByText('there')).toBeInTheDocument())
    await openMenu()
    await userEvent.click(await screen.findByRole('button', { name: 'Version 2 (WEB-DL)' }))
    playerTime(1.5)
    await waitFor(() => expect(screen.getByText('Other version')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Version 2 (WEB-DL)' })).toHaveAttribute('aria-pressed', 'true')
    expect(localStorage.getItem('naijatr.subs.versions')).toContain('sd:/subtitle/2-3.zip')
    await userEvent.click(screen.getByRole('button', { name: 'Version 1 (BluRay)' }))
    playerTime(1.5)
    await waitFor(() => expect(screen.getByText('there')).toBeInTheDocument())
  })

  it('uses the community fix when the viewer has none of their own', async () => {
    render(<Player target={{ tmdbId: 600, type: 'movie' }} />)
    playerTime(1)
    await openMenu()
    await waitFor(() => expect(document.querySelector('.subs-menu__offset')).toHaveTextContent('+2.5s'))
    expect(screen.getByText('Fixed by viewers')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Subtitles 0.5 seconds later' }))
    expect(document.querySelector('.subs-menu__offset')).toHaveTextContent('+3.0s')
    expect(screen.queryByText('Fixed by viewers')).toBeNull()
  })

  it('votes for a changed setting kept for 2 minutes of watching', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      render(<Player />)
      playerTime(1)
      await openMenu()
      await waitFor(() => expect(screen.getByRole('button', { name: 'Version 1 (BluRay)' })).toBeInTheDocument())
      await userEvent.click(screen.getByRole('button', { name: 'Subtitles 0.5 seconds later' }))
      playerTime(2)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 100)
      })
      const vote = fetchMock.mock.calls.find((c) => String(c[0]) === '/api/subtitles/vote')
      expect(vote).toBeTruthy()
      expect(JSON.parse(String((vote![1] as RequestInit).body))).toMatchObject({ tmdbId: 550, type: 'movie', lang: 'en', version: 'os:1', offset: 0.5, speed: '1' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('"Subtitles out of sync?" sends the title, episode and version, once', async () => {
    render(<Player target={{ tmdbId: 1399, type: 'tv', episode: { season: 3, episode: 9 }, title: 'Game of Thrones', server: 'embedmaster' }} />)
    playerTime(1)
    await openMenu()
    await waitFor(() => expect(screen.queryByText('Loading subtitles…')).toBeNull())
    await userEvent.click(screen.getByRole('button', { name: 'Subtitles out of sync?' }))
    expect(screen.getByRole('button', { name: /Thanks, we.ll look at it/ })).toBeDisabled()
    const report = fetchMock.mock.calls.find((c) => String(c[0]) === '/api/subtitles/report')
    expect(JSON.parse(String((report![1] as RequestInit).body))).toMatchObject({ tmdbId: 1399, season: 3, episode: 9, title: 'Game of Thrones', version: 'os:1', server: 'embedmaster' })
  })
})
