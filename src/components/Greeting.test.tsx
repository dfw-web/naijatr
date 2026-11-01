import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { useAdOverlay } from '../ads/adManager'
import { fillMonth, greetingFor, GREETINGS, lagosDate, type Greeting } from '../config/greetings'
import { useHoldNotices } from '../ui/noticeQueue'
import { GreetingHost } from './Greeting'

const greeting: Greeting = { ...GREETINGS[0], id: 'test-new-month', from: '2026-11-01', to: '2026-11-03' }
const at = (iso: string) => () => Date.parse(iso)
const NOV_2 = at('2026-11-02T12:00:00Z')
const host = (props: Partial<Parameters<typeof GreetingHost>[0]> = {}) => (
  <GreetingHost greetings={[greeting]} now={NOV_2} delayMs={0} {...props} />
)
const card = () => screen.queryByRole('dialog', { name: /Happy New Month/ })

/** Stands in for the contest popup, invite guide, Telegram gate or ad break. */
function OtherPopup() {
  const [open, setOpen] = useState(true)
  useAdOverlay(open)
  return open ? <button onClick={() => setOpen(false)}>Close other popup</button> : null
}

/** Stands in for a due "Ads are back" card. */
function AdsBackCard() {
  const [due, setDue] = useState(true)
  useHoldNotices(due)
  return due ? <button onClick={() => setDue(false)}>OK ads</button> : null
}

describe('dates (Lagos time)', () => {
  it('runs from midnight on the first day to the end of the last, in Lagos', () => {
    // Lagos is UTC+1: 23:00 UTC on 31 Oct is already 1 Nov there.
    expect(lagosDate(Date.parse('2026-10-31T23:00:00Z'))).toBe('2026-11-01')
    expect(greetingFor(Date.parse('2026-10-31T22:59:00Z'), [greeting])).toBeNull()
    expect(greetingFor(Date.parse('2026-10-31T23:00:00Z'), [greeting])).toBe(greeting)
    expect(greetingFor(Date.parse('2026-11-03T22:59:00Z'), [greeting])).toBe(greeting)
    expect(greetingFor(Date.parse('2026-11-03T23:00:00Z'), [greeting])).toBeNull()
  })

  it('fills in the month from the start date', () => {
    expect(fillMonth('Welcome to {Month}', { from: '2026-11-01' })).toBe('Welcome to November')
    expect(fillMonth('Welcome to {Month}', { from: '2026-12-01' })).toBe('Welcome to December')
    expect(fillMonth('{Month}! {Month}!', { from: '2027-01-01' })).toBe('January! January!')
  })

  it('shows nothing outside the dates', async () => {
    render(host({ now: at('2026-11-04T09:00:00Z') }))
    await act(() => new Promise((r) => setTimeout(r, 20)))
    expect(card()).not.toBeInTheDocument()
  })
})

describe('GreetingHost', () => {
  it('shows the message, once per device', async () => {
    const user = userEvent.setup()
    const { unmount } = render(host())
    const dialog = await screen.findByRole('dialog', { name: '🎉 Happy New Month! Welcome to November 🍂' })
    expect(dialog).toHaveTextContent('May this month bring you joy, good health, wins and plenty of great movies & match days 🍿⚽')
    expect(dialog).toHaveTextContent("Thank you for watching with NAIJA TR and for all your support. We're just getting started ❤️")
    expect(dialog).toHaveTextContent('— The NAIJA TR Team')
    expect(screen.getByRole('link', { name: /Join our Telegram for this month's picks/ })).toHaveAttribute('href', 'https://t.me/naijatr')

    await user.click(screen.getByRole('button', { name: 'Thank you 🙏' }))
    expect(card()).not.toBeInTheDocument()
    unmount()

    // Another visit on the same device.
    render(host())
    await act(() => new Promise((r) => setTimeout(r, 20)))
    expect(card()).not.toBeInTheDocument()
  })

  it('closes with X, Escape, or a tap anywhere else', async () => {
    const user = userEvent.setup()
    const fresh = (id: string) => ({ ...greeting, id })

    const first = render(host({ greetings: [fresh('x')] }))
    await user.click(await screen.findByRole('button', { name: 'Close' }))
    expect(card()).not.toBeInTheDocument()
    first.unmount()

    const second = render(host({ greetings: [fresh('escape')] }))
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')
    expect(card()).not.toBeInTheDocument()
    second.unmount()

    render(host({ greetings: [fresh('outside')] }))
    await screen.findByRole('dialog')
    fireEvent.pointerDown(document.body)
    expect(card()).not.toBeInTheDocument()
  })

  it('is a card, not a takeover: the page behind stays usable', async () => {
    render(host())
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'false')
    expect(dialog).toHaveClass('greeting')
  })

  it('waits for another popup (contest, invite guide, gate) to close', async () => {
    const user = userEvent.setup()
    render(
      <>
        <OtherPopup />
        {host()}
      </>,
    )
    await act(() => new Promise((r) => setTimeout(r, 20)))
    expect(card()).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close other popup' }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('waits for the "Ads are back" card', async () => {
    const user = userEvent.setup()
    render(
      <>
        <AdsBackCard />
        {host()}
      </>,
    )
    await act(() => new Promise((r) => setTimeout(r, 20)))
    expect(card()).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'OK ads' }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('steps aside if another popup opens over it, and comes back after', async () => {
    const user = userEvent.setup()
    function Later() {
      const [show, setShow] = useState(false)
      return show ? <OtherPopup /> : <button onClick={() => setShow(true)}>Open other popup</button>
    }
    render(
      <>
        <Later />
        {host()}
      </>,
    )
    await screen.findByRole('dialog')
    // A keyboard press, so it isn't a tap outside the card.
    screen.getByRole('button', { name: 'Open other popup' }).focus()
    await user.keyboard('{Enter}')
    expect(card()).not.toBeInTheDocument()
    screen.getByRole('button', { name: 'Close other popup' }).focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('never shows while a player is open', async () => {
    const player = document.createElement('div')
    player.className = 'player__frame'
    document.body.append(player)
    render(host())
    await act(() => new Promise((r) => setTimeout(r, 20)))
    expect(card()).not.toBeInTheDocument()
    // Player closed: it shows on the next look.
    player.remove()
    expect(await screen.findByRole('dialog', {}, { timeout: 2500 })).toBeInTheDocument()
  })

  it('does not show on TV', async () => {
    document.documentElement.classList.add('tv-mode')
    render(host())
    await act(() => new Promise((r) => setTimeout(r, 20)))
    expect(card()).not.toBeInTheDocument()
  })
})
