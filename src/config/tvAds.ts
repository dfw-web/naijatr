/**
 * TV ad and promo settings. TV browsers can't open the direct-link ad in a new
 * tab, and the Vignette / In-Page Push tags can't be closed with a remote, so
 * TVs get an ad break before playback and a banner between home rows instead.
 */

export interface AdZone {
  /** Monetag zone id. */
  zone: string
  /** The zone's script URL, from the zone's code in the Monetag dashboard. */
  src: string
}

/**
 * TODO: a Monetag banner zone for TV (shown in the ad break and between home
 * rows). Create a display/banner-style zone in Monetag and paste its id and
 * script URL here. Until then the ad break shows the "watch on your phone"
 * QR code instead, and the home page shows no ad slot.
 */
export const TV_BANNER_ZONE: AdZone | null = null

/** Seconds the ad break counts down before "Continue" can be pressed. */
export const TV_AD_BREAK_SECONDS = 5

/**
 * TODO: your WhatsApp or Telegram channel link (e.g. https://whatsapp.com/channel/…
 * or https://t.me/…). While empty, the "Get match alerts" QR card is hidden.
 */
export const MATCH_ALERTS_URL = ''
