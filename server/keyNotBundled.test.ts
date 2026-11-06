import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { loadEnv } from 'vite'
import { describe, expect, it } from 'vitest'

/** Every file under `dir`. */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

/**
 * The NextStream (Server 1) API key is read server-side only (server/
 * nextstream.ts). After `npm run build`, nothing the browser downloads may
 * hold it. Skipped without a key in the env files or without a build.
 */
describe('the Server 1 API key', () => {
  const key = loadEnv('production', process.cwd(), '').NEXTSTREAM_API_KEY?.trim() ?? ''

  it.skipIf(!key || !existsSync('dist'))('is in no file of the built site (dist/)', () => {
    const holding = files('dist').filter((path) => readFileSync(path).includes(key))
    expect(holding).toEqual([])
  })

  it('is never read from src/ (that would bundle it)', () => {
    const offenders = files('src').filter((path) => /(import\.meta\.env|process\.env)\.NEXTSTREAM_API_KEY/.test(readFileSync(path, 'utf8')))
    expect(offenders).toEqual([])
  })
})
