import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TELEGRAM_CHANNEL_URL, telegramDestination, telegramGoPath } from '../config/telegram'
import { TelegramBanner, TelegramCard, TelegramFooter, TelegramHeaderLink } from './Telegram'

const DAY = 24 * 60 * 60 * 1000

describe('Telegram call-to-action', () => {
  afterEach(() => vi.useRealTimers())

  it('sends every button through /go/telegram, tagged with where it was', () => {
    render(
      <>
        <TelegramHeaderLink />
        <TelegramCard from="match" />
        <TelegramFooter />
      </>,
    )
    expect(screen.getByRole('link', { name: /Join our channel/ })).toHaveAttribute('href', '/go/telegram?from=header')
    expect(screen.getByRole('link', { name: /Join Channel/ })).toHaveAttribute('href', '/go/telegram?from=match')
    const handle = screen.getByRole('link', { name: '@naijatr' })
    expect(handle).toHaveAttribute('href', '/go/telegram?from=footer')
    // A new tab on desktop.
    expect(handle).toHaveAttribute('target', '_blank')
    expect(screen.getByText(/Our only website is naijatr\.com/)).toBeInTheDocument()
  })

  it('brands the card as the official NAIJA TR channel', () => {
    render(<TelegramCard from="details" />)
    const card = screen.getByRole('complementary', { name: 'NAIJA TR Official Channel on Telegram' })
    expect(card).toHaveTextContent('NAIJA TR Official Channel')
    expect(within(card).getByText('Official')).toHaveClass('tg-official')
    expect(card).toHaveTextContent('Get alerts from the official NAIJA TR channel when new episodes and matches drop, and for daily news updates.')
  })

  it('hides the home banner for a week after X', async () => {
    const { unmount } = render(<TelegramBanner />)
    const banner = screen.getByRole('complementary', { name: 'NAIJA TR Official Channel on Telegram' })
    expect(banner).toHaveTextContent('Join the official NAIJA TR Telegram – daily movie picks, match links and daily news updates straight from naijatr.com.')
    expect(within(banner).getByRole('link', { name: /Join Channel/ })).toHaveAttribute('href', '/go/telegram?from=home-banner')
    await userEvent.click(within(banner).getByRole('button', { name: 'Dismiss for a week' }))
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    unmount()

    vi.useFakeTimers({ now: Date.now() + 6 * DAY, toFake: ['Date'] })
    const again = render(<TelegramBanner />)
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    again.unmount()

    vi.setSystemTime(Date.now() + 2 * DAY)
    render(<TelegramBanner />)
    expect(screen.getByRole('complementary')).toBeInTheDocument()
  })
})

describe('telegram config', () => {
  it('builds the tracked link and picks the app on Android', () => {
    expect(telegramGoPath('footer')).toBe('/go/telegram?from=footer')
    expect(telegramDestination('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe(TELEGRAM_CHANNEL_URL)
    expect(telegramDestination('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('https://t.me/naijatr')
    const android = telegramDestination('Mozilla/5.0 (Linux; Android 14; Pixel 8)')
    expect(android).toMatch(/^intent:\/\/resolve\?domain=naijatr#Intent;scheme=tg;/)
    expect(android).toContain(`S.browser_fallback_url=${encodeURIComponent('https://t.me/naijatr')};end`)
  })
})
