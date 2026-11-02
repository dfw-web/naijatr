import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAdOverlay } from './adManager'
import { AdsBackNotice } from './AdsBackNotice'

const TEXT = '📢 Ads are back on NAIJA TR to keep it free. Want it ad-free? Invite 5 friends 👉 Learn more …or buy ad-free from ₦2,000'

function Popup() {
  useAdOverlay()
  return null
}

beforeEach(() => {
  // setup.ts marks the card seen for the other tests.
  localStorage.removeItem('naijatr.ads.backNotice')
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms))

describe('"Ads are back"', () => {
  it('shows once per device and goes away after 8 seconds', () => {
    const { unmount } = render(<AdsBackNotice />)
    wait(1500)
    expect(screen.getByRole('status')).toHaveTextContent(TEXT)
    expect(screen.getByRole('button', { name: 'OK 👍' })).toBeInTheDocument()
    wait(8000)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    unmount()

    render(<AdsBackNotice />)
    wait(10_000)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('closes on OK', async () => {
    vi.useRealTimers()
    render(<AdsBackNotice />)
    const ok = await screen.findByRole('button', { name: 'OK 👍' }, { timeout: 3000 })
    await userEvent.click(ok)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('waits until another popup is closed', () => {
    const page = (popup: boolean) => (
      <>
        {popup && <Popup />}
        <AdsBackNotice />
      </>
    )
    const { rerender } = render(page(true))
    wait(5000)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    rerender(page(false))
    expect(screen.getByRole('status')).toHaveTextContent('Ads are back')
  })

  it('is not shown on test visits (?noads=1)', () => {
    window.history.replaceState(null, '', '/?noads=1')
    render(<AdsBackNotice />)
    wait(2000)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
