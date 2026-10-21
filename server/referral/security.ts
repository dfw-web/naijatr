/**
 * The referral program's security pieces: checking a Telegram Login Widget
 * sign-in, signed session tokens, salted IP hashes (raw IPs are never kept)
 * and the winners' encrypted claim details (AES-256-GCM).
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export interface TelegramUser {
  id: number
  first_name: string
  last_name?: string
  username?: string
  photo_url?: string
  auth_date: number
  hash: string
}

/** A sign-in older than this is refused (replayed widget data). */
export const AUTH_MAX_AGE_S = 24 * 60 * 60

const sameHex = (a: string, b: string) =>
  a.length === b.length && /^[0-9a-f]+$/.test(a) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))

/**
 * The widget's data, if Telegram signed it for our bot
 * (core.telegram.org/widgets/login#checking-authorization).
 */
export function verifyTelegramLogin(data: unknown, botToken: string, now = Date.now()): TelegramUser | null {
  if (!botToken || typeof data !== 'object' || data === null) return null
  const fields = data as Record<string, unknown>
  const hash = typeof fields.hash === 'string' ? fields.hash.toLowerCase() : ''
  const checkString = Object.keys(fields)
    .filter((key) => key !== 'hash' && fields[key] !== undefined && fields[key] !== null)
    .sort()
    .map((key) => `${key}=${String(fields[key])}`)
    .join('\n')
  const secret = createHash('sha256').update(botToken).digest()
  const expected = createHmac('sha256', secret).update(checkString).digest('hex')
  if (!hash || !sameHex(hash, expected)) return null
  const id = Number(fields.id)
  const authDate = Number(fields.auth_date)
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isFinite(authDate)) return null
  if (now / 1000 - authDate > AUTH_MAX_AGE_S) return null
  return {
    id,
    first_name: String(fields.first_name ?? ''),
    last_name: typeof fields.last_name === 'string' ? fields.last_name : undefined,
    username: typeof fields.username === 'string' ? fields.username : undefined,
    auth_date: authDate,
    hash,
  }
}

/** How long a sign-in lasts on a device. */
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000

const sign = (secret: string, text: string) => createHmac('sha256', secret).update(`session:${text}`).digest('base64url')

/** "<telegram id>.<expiry>.<signature>" */
export function createSession(secret: string, userId: number, now = Date.now()): string {
  const body = `${userId}.${now + SESSION_TTL_MS}`
  return `${body}.${sign(secret, body)}`
}

/** The signed-in Telegram id, or null for a missing, forged or expired token. */
export function readSession(secret: string, token: string | undefined, now = Date.now()): number | null {
  if (!secret || !token) return null
  const match = /^(\d{1,20})\.(\d{10,16})\.([A-Za-z0-9_-]{43})$/.exec(token.trim())
  if (!match) return null
  const [, id, expiry, signature] = match
  const expected = sign(secret, `${id}.${expiry}`)
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null
  if (Number(expiry) < now) return null
  const userId = Number(id)
  return Number.isSafeInteger(userId) ? userId : null
}

/** The bearer token of a request, if any. */
export const bearer = (authorization: string | undefined) => /^Bearer (.+)$/.exec(authorization ?? '')?.[1]

/** A short salted hash of an IP: enough to spot many referrals from one network, never the IP. */
export const hashIp = (salt: string, ip: string) =>
  createHash('sha256').update(`ip:${salt}:${ip}`).digest('hex').slice(0, 16)

/** Same for the browser's user agent (repeated-device patterns). */
export const hashAgent = (salt: string, agent: string) =>
  createHash('sha256').update(`ua:${salt}:${agent}`).digest('hex').slice(0, 12)

/** A one-time, unguessable claim link token. */
export const claimToken = () => randomBytes(32).toString('base64url')

const claimKey = (secret: string) => createHash('sha256').update(`claim:${secret}`).digest()

/** "iv.tag.data" (base64url), AES-256-GCM with a key from CLAIM_ENCRYPTION_KEY. */
export function encrypt(secret: string, plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', claimKey(secret), iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.')
}

/** The plain text, or null if the key is wrong or the data was changed. */
export function decrypt(secret: string, sealed: string): string | null {
  try {
    const [iv, tag, data] = sealed.split('.').map((part) => Buffer.from(part, 'base64url'))
    const decipher = createDecipheriv('aes-256-gcm', claimKey(secret), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}
