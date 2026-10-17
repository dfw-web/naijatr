/** The official NAIJA TR Telegram channel. Everything Telegram on the site comes from this one value. */
export const TELEGRAM_CHANNEL_URL = 'https://t.me/naijatr'

/** The channel's username, e.g. "naijatr" (shown as @naijatr). */
export const TELEGRAM_USERNAME = new URL(TELEGRAM_CHANNEL_URL).pathname.replace(/^\/+|\/+$/g, '')

/** Our only website, shown next to the channel so copycats are easy to spot. */
export const OFFICIAL_SITE = 'naijatr.com'

export const TELEGRAM_PITCH = `Join the official NAIJA TR Telegram – daily movie picks, match links and daily news updates straight from ${OFFICIAL_SITE}.`

/** Where the site's placements send people: /go/telegram records the visit, then opens the channel. */
export type TelegramPlacement = 'header' | 'menu' | 'home-banner' | 'details' | 'match' | 'footer' | 'tv' | 'gate'

export const telegramGoPath = (from: TelegramPlacement) => `/go/telegram?from=${from}`

/**
 * Where /go/telegram sends this device: the Telegram app on Android (falling
 * back to the web page if it isn't installed), t.me everywhere else; t.me
 * itself hands over to the app on iPhone.
 */
export function telegramDestination(userAgent: string): string {
  if (/Android/i.test(userAgent)) {
    const fallback = encodeURIComponent(TELEGRAM_CHANNEL_URL)
    return `intent://resolve?domain=${TELEGRAM_USERNAME}#Intent;scheme=tg;package=org.telegram.messenger;S.browser_fallback_url=${fallback};end`
  }
  return TELEGRAM_CHANNEL_URL
}
