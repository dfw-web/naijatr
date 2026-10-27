import { render, screen, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { MediaItem } from '../types/media'
import { ScreenScapeDownload } from './ScreenScapeDownload'

afterEach(cleanup)

describe('ScreenScape download navigation', () => {
  it.each([['movie', 'movie'], ['series', 'tv']] as const)('opens the %s title download page without invoking the worker', (type, path) => {
    render(<ScreenScapeDownload item={{ type, tmdbId: 10378 } as MediaItem} />)
    const link = screen.getByRole('link', { name: 'Download' })
    expect(link).toHaveAttribute('href', `https://nxsha.screenscape.me/download/${path}/10378`)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(link).not.toHaveAttribute('download')
  })

  it.each([undefined, 0, -1, NaN])('hides download when the title ID is invalid (%s)', (tmdbId) => {
    render(<ScreenScapeDownload item={{ type: 'movie', tmdbId } as MediaItem} />)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})
