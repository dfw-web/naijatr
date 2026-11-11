import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SubtitleMenu, SubtitleOverlay, usePlayerSubtitles } from './PlayerSubtitles'
import { cuesAt, parseVtt, saveSubtitleOffset, setSubtitleChoice, subtitleChoice, subtitleOffset, type SubtitleTarget } from './subtitles'

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

describe('the player overlay', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    localStorage.clear()
    setSubtitleChoice('en', false)
    fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('/api/subtitles/languages')) {
        return new Response(JSON.stringify({ languages: [{ code: 'en', name: 'English', available: true }, { code: 'fr', name: 'French', available: true }] }))
      }
      if (url.includes('lang=en')) return new Response(VTT)
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
    await userEvent.click(screen.getByRole('button', { name: /CC/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Off' }))
    expect(subtitleChoice()).toBe('off')
    expect(screen.queryByText('No subtitles found')).toBeNull()
  })
})
