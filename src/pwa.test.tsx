import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Navbar } from './components/Navbar'
import { NAV_LINKS } from './navigation'
import { listenForInstallPrompt } from './pwa'
import indexHtml from '../index.html?raw'
import manifestText from '../public/manifest.webmanifest?raw'
import serviceWorker from '../public/sw.js?raw'

// Files Vite serves from public/, as site paths (/favicon.svg, /icons/...).
const PUBLIC_FILES = Object.keys(import.meta.glob('../public/**/*')).map((p) => p.slice('../public'.length))
const exists = (path: string) => PUBLIC_FILES.includes(path)

const renderNavbar = () =>
  render(
    <Navbar links={NAV_LINKS} activeId="home" query="" onQueryChange={vi.fn()} onNavigate={vi.fn()} />,
  )

/** Fires the event Chrome sends when the app can be installed. */
function offerInstall(outcome: 'accepted' | 'dismissed' = 'accepted') {
  const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt: vi.fn(async () => {}),
    userChoice: Promise.resolve({ outcome }),
  })
  act(() => {
    window.dispatchEvent(event)
  })
  return event
}

describe('Installable app', () => {
  let stop: (() => void) | undefined
  afterEach(() => {
    act(() => {
      window.dispatchEvent(new Event('appinstalled'))
    })
    stop?.()
  })

  it('shows Install app only when the browser offers it, and opens the install dialog', async () => {
    stop = listenForInstallPrompt()
    renderNavbar()
    expect(screen.queryByRole('button', { name: /Install app/ })).not.toBeInTheDocument()

    const event = offerInstall()
    expect(event.defaultPrevented).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: /Install app/ }))
    expect(event.prompt).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: /Install app/ })).not.toBeInTheDocument()
  })

  it('hides the button once the app is installed', () => {
    stop = listenForInstallPrompt()
    renderNavbar()
    offerInstall()
    expect(screen.getByRole('button', { name: /Install app/ })).toBeInTheDocument()
    act(() => {
      window.dispatchEvent(new Event('appinstalled'))
    })
    expect(screen.queryByRole('button', { name: /Install app/ })).not.toBeInTheDocument()
  })

  it('ships a manifest whose icons exist, linked from index.html', () => {
    const manifest = JSON.parse(manifestText) as {
      display: string
      start_url: string
      icons: { src: string; sizes: string; purpose?: string }[]
    }
    expect(manifest.display).toBe('standalone')
    expect(manifest.start_url).toBe('/')
    for (const icon of manifest.icons) expect(exists(icon.src)).toBe(true)
    expect(manifest.icons.map((i) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']))
    expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true)

    expect(indexHtml).toContain('<link rel="manifest" href="/manifest.webmanifest" />')
    expect(indexHtml).toContain('href="/icons/apple-touch-icon.png"')
  })

  it('never caches /api or video players in the service worker', () => {
    expect(serviceWorker).toMatch(/startsWith\('\/api\/'\)\) return/)
    for (const path of JSON.parse(serviceWorker.match(/const SHELL = (\[.*\])/)?.[1].replace(/'/g, '"') ?? '[]') as string[]) {
      expect(path === '/' || exists(path)).toBe(true)
    }
  })
})
