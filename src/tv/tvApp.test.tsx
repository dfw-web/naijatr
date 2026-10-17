import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from '../App'
import { createLocalProvider } from '../data/localProvider'
import { CatalogProviderContext } from '../data/provider'
import type { CatalogProvider, MediaItem } from '../types/media'
import { recordPlay } from '../utils/continueWatching'

const local = createLocalProvider({ latencyMs: 0 })

function renderApp(provider: CatalogProvider = local) {
  render(
    <CatalogProviderContext.Provider value={provider}>
      <App />
    </CatalogProviderContext.Provider>,
  )
}

describe('title links (?title=, used by the TV QR codes)', () => {
  it('opens the title from its id and forgets the link once closed', async () => {
    window.history.replaceState(null, '', '/?title=series-1399&utm_source=tv_qr')
    const provider: CatalogProvider = {
      ...local,
      getDetails: async (item: MediaItem) => ({ ...item, title: 'Game of Thrones', description: 'Winter is coming.' }),
    }
    renderApp(provider)
    const dialog = await screen.findByRole('dialog', { name: 'Game of Thrones' })
    expect(dialog).toHaveTextContent('Winter is coming.')
    within(dialog).getByRole('button', { name: 'Close details' }).click()
    expect(await screen.findByRole('heading', { name: 'Popular Series' })).toBeInTheDocument()
    expect(window.location.search).toBe('')
  })

  it('ignores a malformed link', async () => {
    window.history.replaceState(null, '', '/?title=person-1')
    renderApp()
    await screen.findByRole('heading', { name: 'Popular Series' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('TV home page', () => {
  it('starts with the Continue watching row of recently played titles', async () => {
    const [first] = await local.getByType('movie')
    recordPlay(first)
    document.documentElement.classList.add('tv-mode')
    renderApp()
    const row = await screen.findByRole('region', { name: 'Continue watching' })
    expect(within(row).getByRole('button', { name: `Continue watching ${first.title}` })).toBeInTheDocument()
  })
})
