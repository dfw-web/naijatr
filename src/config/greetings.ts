/**
 * Seasonal greetings (src/components/Greeting.tsx): a friendly card, once per
 * device, between two dates in Lagos time. To add next month's (or
 * Christmas, or New Year), copy an entry, give it a new `id` and change the
 * dates and text. "{Month}" becomes the month of `from` ("November").
 */
export interface Greeting {
  /** New for every greeting: each device sees each id once. */
  id: string
  /** First and last day it shows (YYYY-MM-DD, Lagos time), inclusive. */
  from: string
  to: string
  title: string
  /** Paragraphs under the title. */
  message: string[]
  signature: string
  button: string
  /** Text before the Telegram link, or null for no link. */
  telegram: string | null
}

export const GREETINGS: Greeting[] = [
  {
    id: 'new-month-2026-11',
    from: '2026-11-01',
    to: '2026-11-03',
    title: '🎉 Happy New Month! Welcome to {Month} 🍂',
    message: [
      'May this month bring you joy, good health, wins and plenty of great movies & match days 🍿⚽',
      "Thank you for watching with NAIJA TR and for all your support. We're just getting started ❤️",
    ],
    signature: '— The NAIJA TR Team',
    button: 'Thank you 🙏',
    telegram: "Join our Telegram for this month's picks 👉",
  },
]

/** Lagos is UTC+1 all year (no daylight saving). */
export const lagosDate = (now: number) => new Date(now + 60 * 60_000).toISOString().slice(0, 10)

/** The greeting for today in Lagos, if any. */
export const greetingFor = (now: number, greetings: Greeting[] = GREETINGS) => {
  const today = lagosDate(now)
  return greetings.find((g) => g.from <= today && today <= g.to) ?? null
}

/** "{Month}" → the month the greeting starts in. */
export function fillMonth(text: string, greeting: Pick<Greeting, 'from'>) {
  const month = new Date(`${greeting.from}T12:00:00Z`).toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' })
  // split/join: replaceAll is missing on older smart-TV browsers.
  return text.split('{Month}').join(month)
}
