/**
 * Upstash Redis over its REST API (no client library), shared by the live
 * viewer counter (server/live) and the football stream cache
 * (server/football/streamingStore.ts).
 *
 * Imports use `.js` specifiers so the compiled Vercel functions resolve them.
 */

const REDIS_TIMEOUT_MS = 5000

export interface RedisEnv {
  redisUrl: string
  redisToken: string
}

/** The Vercel Marketplace's Upstash integration sets KV_REST_API_*; a direct Upstash setup, UPSTASH_REDIS_REST_*. */
export function readRedisEnv(env: Record<string, string | undefined>): RedisEnv {
  return {
    redisUrl: (env.KV_REST_API_URL ?? env.UPSTASH_REDIS_REST_URL ?? '').trim().replace(/\/+$/, ''),
    redisToken: (env.KV_REST_API_TOKEN ?? env.UPSTASH_REDIS_REST_TOKEN ?? '').trim(),
  }
}

export const hasRedis = (env: RedisEnv) => Boolean(env.redisUrl && env.redisToken)

export type Command = (string | number)[]

/** Several Redis commands in one request. Never throws; null when Redis can't be reached. */
export async function redis(env: RedisEnv, commands: Command[], fetchImpl: typeof fetch = fetch): Promise<unknown[] | null> {
  if (!hasRedis(env)) return null
  try {
    const response = await fetchImpl(`${env.redisUrl}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.redisToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands.map((command) => command.map(String))),
      signal: AbortSignal.timeout(REDIS_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const body = (await response.json()) as { result?: unknown; error?: string }[]
    return Array.isArray(body) ? body.map((entry) => (entry && !entry.error ? entry.result : null)) : null
  } catch {
    return null
  }
}
