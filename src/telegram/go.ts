import { inject } from '@vercel/analytics'
import { telegramDestination } from '../config/telegram'

/**
 * /go/telegram: records a page view in Vercel Analytics (with ?from= telling
 * which button was used), then opens the channel. If the analytics script is
 * blocked or slow, it goes anyway after a moment.
 */
const GIVE_UP_MS = 1500
// Lets the page view leave before the page does.
const AFTER_SEND_MS = 150

const destination = telegramDestination(navigator.userAgent)
const button = document.getElementById('open') as HTMLAnchorElement | null
if (button) button.href = destination

let gone = false
const go = () => {
  if (gone) return
  gone = true
  window.location.replace(destination)
}

inject({
  beforeSend: (event) => {
    window.setTimeout(go, AFTER_SEND_MS)
    return event
  },
})
window.setTimeout(go, GIVE_UP_MS)
