/**
 * Each drama app's own page for a drama, for "Continue on DramaBox" on the
 * home page's "Your short dramas" row. Checked against the official sites:
 *
 * - DramaBox: https://www.dramaboxdb.com/movie/{bookId} (the title slug after it is optional);
 * - NetShort: https://www.netshort.com/episode/{slug}-{id} (some slug is required; any works);
 * - DramaWave (and any app added later): its site doesn't load, so a search for it
 *   in the App Store (iPhone, iPad) or Google Play.
 *
 * On a phone with the app installed, the app's own links open it.
 */

export const PROVIDER_LABELS: Record<string, string> = {
  dramabox: 'DramaBox',
  dramawave: 'DramaWave',
  netshort: 'NetShort',
  reelshort: 'ReelShort',
}

/** The app's name, e.g. "DramaBox" (a provider we don't know: its id, capitalised). */
export const providerLabel = (provider: string) => PROVIDER_LABELS[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1)

/** "Satan’s Daughter, Revenge!" → "satans-daughter-revenge". */
export function titleSlug(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/[\s-]+/g, '-') || 'drama'
  )
}

const isApple = (userAgent: string) => /iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && /Mobile/i.test(userAgent))

const storeSearch = (name: string, userAgent: string) =>
  isApple(userAgent)
    ? `https://apps.apple.com/us/iphone/search?term=${encodeURIComponent(name)}`
    : `https://play.google.com/store/search?q=${encodeURIComponent(name)}&c=apps`

export function officialDramaUrl(
  entry: { provider: string; dramaId: string; title: string },
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent,
): string {
  const id = encodeURIComponent(entry.dramaId)
  switch (entry.provider) {
    case 'dramabox':
      return `https://www.dramaboxdb.com/movie/${id}`
    case 'netshort':
      return `https://www.netshort.com/episode/${titleSlug(entry.title)}-${id}`
    default:
      return storeSearch(providerLabel(entry.provider), userAgent)
  }
}
