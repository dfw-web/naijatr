import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InstallAppHost } from './components/InstallApp'
import { Navbar } from './components/Navbar'
import { NAV_LINKS } from './navigation'
import { listenForInstallPrompt } from './pwa'
import { resetInstallApp } from './installAppStore'
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

  it('shows Download app only when the browser offers it, and opens the install dialog', async () => {
    stop = listenForInstallPrompt()
    renderNavbar()
    expect(screen.queryByRole('button', { name: /Download app/ })).not.toBeInTheDocument()

    const event = offerInstall()
    expect(event.defaultPrevented).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: /Download app/ }))
    expect(event.prompt).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: /Download app/ })).not.toBeInTheDocument()
  })

  it('hides the button once the app is installed', () => {
    stop = listenForInstallPrompt()
    renderNavbar()
    offerInstall()
    expect(screen.getByRole('button', { name: /Download app/ })).toBeInTheDocument()
    act(() => {
      window.dispatchEvent(new Event('appinstalled'))
    })
    expect(screen.queryByRole('button', { name: /Download app/ })).not.toBeInTheDocument()
  })

  it('shows a Download app bar at the bottom that the viewer can put off for a few days', async () => {
    stop = listenForInstallPrompt()
    const { unmount } = render(<InstallAppHost />)
    expect(screen.queryByRole('complementary', { name: 'Download the NAIJA TR app' })).not.toBeInTheDocument()

    const event = offerInstall()
    const bar = screen.getByRole('complementary', { name: 'Download the NAIJA TR app' })
    expect(document.documentElement).toHaveClass('has-install-bar')
    await userEvent.click(within(bar).getByRole('button', { name: /Download app/ }))
    expect(event.prompt).toHaveBeenCalledOnce()

    offerInstall()
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    expect(document.documentElement).not.toHaveClass('has-install-bar')
    unmount()
    // Still put off on the next visit; the header button stays.
    resetInstallApp()
    render(<InstallAppHost />)
    renderNavbar()
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Download app/ })).toBeInTheDocument()
  })

  it('shows iPhone visitors how to add the app from the Share menu', async () => {
    const ua = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1')
    try {
      render(<InstallAppHost />)
      renderNavbar()
      await userEvent.click(screen.getByRole('banner').querySelector('button.navbar__install--download')!)
      const steps = screen.getByRole('dialog', { name: 'Add NAIJA TR to your home screen' })
      expect(steps).toHaveTextContent('Add to Home Screen')
      await userEvent.click(within(steps).getByRole('button', { name: 'Got it' }))
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    } finally {
      ua.mockRestore()
    }
  })

  it('shows Android visitors without an install dialog (e.g. in Telegram) how to install from the menu', async () => {
    const ua = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari/537.36 Telegram-Android/11.0')
    try {
      render(<InstallAppHost />)
      const bar = screen.getByRole('complementary', { name: 'Download the NAIJA TR app' })
      await userEvent.click(within(bar).getByRole('button', { name: /Download app/ }))
      const steps = screen.getByRole('dialog', { name: 'Add NAIJA TR to your home screen' })
      expect(steps).toHaveTextContent('Open in Chrome')
      expect(steps).toHaveTextContent('Install app')
    } finally {
      ua.mockRestore()
    }
  })

  it('shows nothing inside the installed app or on TVs', () => {
    const ua = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1')
    const standalone = Object.getOwnPropertyDescriptor(navigator, 'standalone')
    try {
      Object.defineProperty(navigator, 'standalone', { value: true, configurable: true })
      render(<InstallAppHost />)
      renderNavbar()
      expect(screen.queryByRole('button', { name: /Download app/ })).not.toBeInTheDocument()
      expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    } finally {
      if (standalone) Object.defineProperty(navigator, 'standalone', standalone)
      else delete (navigator as { standalone?: boolean }).standalone
      ua.mockRestore()
    }
    document.documentElement.classList.add('tv-mode')
    stop = listenForInstallPrompt()
    render(<InstallAppHost />)
    offerInstall()
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
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
