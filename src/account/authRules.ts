import { useEffect, useState } from 'react'
import { useEmailCooldownUntil } from './account'

/** "Why create a free account?" — on the sign-in sheet and the gentle prompt. */
export const BENEFITS = [
  'Continue Watching on any phone, laptop or TV',
  'Save movies & series to My List',
  'Better recommendations for you',
  'Get the new link if NAIJA TR ever moves',
  'Join contests & giveaways',
]

/** Seconds left before another email may be sent; ticks every second. */
export function useCooldownSeconds(): number {
  const until = useEmailCooldownUntil()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (until <= Date.now()) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [until])
  return Math.max(0, Math.ceil((until - now) / 1000))
}

export const MIN_PASSWORD = 8

/** A rough strength hint: length plus the kinds of characters used. */
export function passwordStrength(password: string): { label: string; level: 0 | 1 | 2 | 3 } {
  if (password.length < MIN_PASSWORD) return { label: `At least ${MIN_PASSWORD} characters`, level: 0 }
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length
  const score = kinds + (password.length >= 12 ? 1 : 0)
  if (score >= 4) return { label: 'Strong', level: 3 }
  if (score >= 3) return { label: 'Good', level: 2 }
  return { label: 'Weak: add numbers, symbols or more letters', level: 1 }
}
