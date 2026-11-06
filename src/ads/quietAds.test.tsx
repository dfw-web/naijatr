import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeSignIn, openSignIn, resetAccount, setAccountForTests } from '../account/account'
import { PasswordForm } from '../account/authParts'
import { SignInHost } from '../account/SignInSheet'
import { adLinkClicks } from '../test/ads'
import { cardAd, installQuietZones } from './adManager'
import { adsDisabled } from './directLink'
import { loadMultitag } from './monetag'

/** A real tap, as the site's cards make. */
function tap(fn: (event: Event) => void) {
  const button = document.createElement('button')
  button.addEventListener('click', fn)
  document.body.append(button)
  button.click()
  button.remove()
}

afterEach(() => {
  resetAccount()
  document.querySelectorAll('script[data-zone]').forEach((node) => node.remove())
})

describe('no ads while signing up or choosing a password', () => {
  it('shows no ads on the pages the email links open (create your password, reset it)', () => {
    for (const path of ['/auth/confirm', '/auth/reset', '/auth/confirm/']) {
      expect(adsDisabled(`https://www.naijatr.com${path}`)).toBe(true)
    }
    // Nor on the account and privacy pages.
    expect(adsDisabled('https://www.naijatr.com/account')).toBe(true)
    expect(adsDisabled('https://www.naijatr.com/privacy')).toBe(true)
    expect(adsDisabled('https://www.naijatr.com/my-list')).toBe(false)
    window.history.replaceState(null, '', '/auth/confirm')
    expect(loadMultitag()).toBe(false)
    // Moving on into the site: the Multitag loads.
    window.history.replaceState(null, '', '/')
    expect(loadMultitag()).toBe(true)
  })

  it('opens no direct-link ad while the sign-in sheet is open', () => {
    setAccountForTests({ status: 'signedOut' })
    act(() => openSignIn('create'))
    render(<SignInHost />)
    expect(screen.getByRole('dialog', { name: 'Your NAIJA TR account' })).toHaveAttribute('data-quiet-ads')
    tap((event) => cardAd(event, { id: 'a' }))
    expect(adLinkClicks()).toHaveLength(0)
    act(() => closeSignIn())
    tap((event) => cardAd(event, { id: 'a' }))
    expect(adLinkClicks()).toHaveLength(1)
  })

  it('keeps taps in password forms away from page-wide ad listeners, while the form still works', async () => {
    const onSave = vi.fn(async (_password: string) => null)
    const { container } = render(
      <>
        <PasswordForm onSubmit={onSave} submitLabel="Save password" />
        <button type="button">Elsewhere</button>
      </>,
    )
    installQuietZones(container)
    const pageWide = vi.fn()
    document.addEventListener('click', pageWide)
    document.addEventListener('pointerdown', pageWide)
    try {
      const [password, confirm] = screen.getAllByLabelText(/password/i).filter((node) => node.tagName === 'INPUT')
      await userEvent.type(password, 'longpassword1')
      await userEvent.type(confirm, 'longpassword1')
      await userEvent.click(screen.getByRole('button', { name: 'Save password' }))
      // React handled the tap (the password was saved)…
      expect(onSave).toHaveBeenCalledWith('longpassword1')
      // …but nothing listening on the whole page heard any of it.
      expect(pageWide).not.toHaveBeenCalled()
      await userEvent.click(screen.getByRole('button', { name: 'Elsewhere' }))
      expect(pageWide).toHaveBeenCalled()
    } finally {
      document.removeEventListener('click', pageWide)
      document.removeEventListener('pointerdown', pageWide)
    }
  })
})
