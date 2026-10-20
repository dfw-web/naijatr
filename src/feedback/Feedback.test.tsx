import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FeedbackHost, RateThis } from './Feedback'

let fetchMock: ReturnType<typeof vi.fn>
const sent = () => fetchMock.mock.calls.map(([url, init]) => ({ url, body: JSON.parse(String((init as RequestInit).body)) }))

beforeEach(() => {
  window.localStorage.clear()
  fetchMock = vi.fn(async () => new Response('{"ok":true}'))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('Feedback', () => {
  it('sends a review with stars, type and name, then thanks the viewer', async () => {
    const user = userEvent.setup()
    render(<FeedbackHost />)
    await user.click(screen.getByRole('button', { name: /Feedback/ }))
    const dialog = screen.getByRole('dialog', { name: 'Send us feedback' })
    await user.click(within(dialog).getByRole('radio', { name: 'Request a movie or series' }))
    await user.click(within(dialog).getByRole('radio', { name: '4 stars' }))
    await user.type(within(dialog).getByRole('textbox', { name: 'Message' }), 'Please add Squid Game 3')
    await user.type(within(dialog).getByRole('textbox', { name: /Telegram @username/ }), '@fan')
    await user.click(within(dialog).getByRole('button', { name: 'Send' }))

    expect(await screen.findByText('Thanks! We read every message 🙏')).toBeInTheDocument()
    const [{ url, body }] = sent()
    expect(url).toBe('/api/feedback/send')
    expect(body).toMatchObject({ type: 'request', rating: 4, message: 'Please add Squid Game 3', name: '@fan', website: '', page: '/' })
    expect(body.device).toMatch(/^[A-Za-z0-9_-]{16,64}$/)
  })

  it('allows 3 messages a day on a device', async () => {
    const user = userEvent.setup()
    render(<FeedbackHost />)
    for (let i = 0; i < 3; i += 1) {
      await user.click(screen.getByRole('button', { name: /Feedback/ }))
      await user.type(screen.getByRole('textbox', { name: 'Message' }), `Message ${i}`)
      await user.click(screen.getByRole('button', { name: 'Send' }))
      await screen.findByText('Thanks! We read every message 🙏')
      await user.click(screen.getAllByRole('button', { name: 'Close' })[0])
    }
    await user.click(screen.getByRole('button', { name: /Feedback/ }))
    expect(screen.getByRole('alert')).toHaveTextContent('3 messages a day')
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('is not shown on TVs', () => {
    document.documentElement.classList.add('tv-mode')
    try {
      render(<FeedbackHost />)
      expect(screen.queryByRole('button', { name: /Feedback/ })).not.toBeInTheDocument()
    } finally {
      document.documentElement.classList.remove('tv-mode')
    }
  })
})

describe('Rate this', () => {
  it('sends the stars with the title and remembers them', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<RateThis titleKey="movie:550" title="Fight Club" />)
    await user.click(screen.getByRole('radio', { name: '5 stars' }))
    expect(await screen.findByText('Thanks for rating!')).toBeInTheDocument()
    expect(sent()[0].body).toMatchObject({ type: 'rating', rating: 5, title: 'Fight Club' })
    unmount()
    render(<RateThis titleKey="movie:550" title="Fight Club" />)
    expect(screen.getByRole('radio', { name: '5 stars' })).toHaveAttribute('aria-checked', 'true')
  })
})
