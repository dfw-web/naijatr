/**
 * An in-memory stand-in for Upstash's /pipeline endpoint, for tests: the
 * commands the server code uses, with Redis's replies. Pass `fetchImpl`.
 */
export function fakeRedis(now: () => number = Date.now) {
  const strings = new Map<string, string>()
  const sets = new Map<string, Set<string>>()
  const lists = new Map<string, string[]>()
  const hashes = new Map<string, Map<string, string>>()
  const zsets = new Map<string, Map<string, number>>()
  const expiry = new Map<string, number>()

  const all = [strings, sets, lists, hashes, zsets]
  const sweep = (key: string) => {
    const at = expiry.get(key)
    if (at !== undefined && at <= now()) {
      all.forEach((m) => m.delete(key))
      expiry.delete(key)
    }
  }
  const get = <T>(map: Map<string, T>, key: string, make: () => T) => {
    sweep(key)
    if (!map.has(key)) map.set(key, make())
    return map.get(key)!
  }

  function run([name, ...args]: string[]): unknown {
    const key = args[0]
    if (key) sweep(key)
    switch (name.toUpperCase()) {
      case 'GET':
        return strings.get(key) ?? null
      case 'SCAN': {
        // One pass returns everything: cursor "0", keys matching MATCH (only a trailing * is supported).
        const match = args[args.findIndex((a) => a.toUpperCase() === 'MATCH') + 1] ?? '*'
        const prefix = match.replace(/\*$/, '')
        return ['0', [...strings.keys()].filter((k) => (sweep(k), strings.has(k) && k.startsWith(prefix)))]
      }
      case 'MGET':
        return args.map((k) => (sweep(k), strings.get(k) ?? null))
      case 'SET': {
        const flags = args.slice(2).map((a) => a.toUpperCase())
        if (flags.includes('NX') && strings.has(key)) return null
        strings.set(key, args[1])
        const ex = flags.indexOf('EX')
        if (ex !== -1) expiry.set(key, now() + Number(args[2 + ex + 1]) * 1000)
        else expiry.delete(key)
        return 'OK'
      }
      case 'DEL': {
        let n = 0
        for (const k of args) all.forEach((m) => m.delete(k) && (n += 1))
        return n
      }
      case 'INCR': {
        const value = Number(strings.get(key) ?? 0) + 1
        strings.set(key, String(value))
        return value
      }
      case 'EXPIRE':
        expiry.set(key, now() + Number(args[1]) * 1000)
        return 1
      case 'SADD': {
        const set = get(sets, key, () => new Set<string>())
        const before = set.size
        args.slice(1).forEach((m) => set.add(m))
        return set.size - before
      }
      case 'SISMEMBER':
        return sets.get(key)?.has(args[1]) ? 1 : 0
      case 'SMEMBERS':
        return [...(sets.get(key) ?? [])]
      case 'LPUSH': {
        const list = get(lists, key, () => [])
        args.slice(1).forEach((v) => list.unshift(v))
        return list.length
      }
      case 'LTRIM': {
        const list = lists.get(key) ?? []
        lists.set(key, list.slice(Number(args[1]), Number(args[2]) + 1))
        return 'OK'
      }
      case 'LRANGE': {
        const list = lists.get(key) ?? []
        const end = Number(args[2])
        return list.slice(Number(args[1]), end === -1 ? undefined : end + 1)
      }
      case 'HINCRBY': {
        const hash = get(hashes, key, () => new Map<string, string>())
        const value = Number(hash.get(args[1]) ?? 0) + Number(args[2])
        hash.set(args[1], String(value))
        return value
      }
      case 'HSET': {
        const hash = get(hashes, key, () => new Map<string, string>())
        let added = 0
        for (let i = 1; i + 1 < args.length; i += 2) {
          if (!hash.has(args[i])) added += 1
          hash.set(args[i], args[i + 1])
        }
        return added
      }
      case 'HSETNX': {
        const hash = get(hashes, key, () => new Map<string, string>())
        if (hash.has(args[1])) return 0
        hash.set(args[1], args[2])
        return 1
      }
      case 'HGET':
        return hashes.get(key)?.get(args[1]) ?? null
      case 'HDEL': {
        const hash = hashes.get(key)
        return args.slice(1).filter((f) => hash?.delete(f)).length
      }
      case 'SCARD':
        return sets.get(key)?.size ?? 0
      case 'ZINCRBY': {
        const zset = get(zsets, key, () => new Map<string, number>())
        const value = (zset.get(args[2]) ?? 0) + Number(args[1])
        zset.set(args[2], value)
        return String(value)
      }
      case 'ZSCORE': {
        const score = zsets.get(key)?.get(args[1])
        return score === undefined ? null : String(score)
      }
      case 'ZCOUNT': {
        const bound = (v: string) => (v === '-inf' ? -Infinity : v === '+inf' ? Infinity : Number(v))
        return [...(zsets.get(key)?.values() ?? [])].filter((score) => score >= bound(args[1]) && score <= bound(args[2])).length
      }
      case 'ZCARD':
        return zsets.get(key)?.size ?? 0
      case 'HGETALL':
        return [...(hashes.get(key) ?? [])].flat()
      case 'ZADD': {
        const zset = get(zsets, key, () => new Map<string, number>())
        const gt = args[1].toUpperCase() === 'GT'
        const [score, member] = gt ? [Number(args[2]), args[3]] : [Number(args[1]), args[2]]
        const old = zset.get(member)
        if (!gt || old === undefined || score > old) zset.set(member, score)
        return old === undefined ? 1 : 0
      }
      case 'ZRANGE': {
        const flags = args.slice(3).map((a) => a.toUpperCase())
        let entries = [...(zsets.get(key) ?? [])].sort((a, b) => a[1] - b[1])
        if (flags.includes('REV')) entries.reverse()
        if (flags.includes('BYSCORE')) {
          const bound = (v: string) => (v === '-inf' ? -Infinity : v === '+inf' ? Infinity : Number(v.replace('(', '')))
          entries = entries.filter(([, score]) => score >= bound(args[1]) && score <= bound(args[2]))
        } else {
          const stop = Number(args[2])
          entries = entries.slice(Number(args[1]), stop === -1 ? undefined : stop + 1)
        }
        // Scores only WITHSCORES, as Redis does (older tests asked BYSCORE … WITHSCORES).
        return flags.includes('WITHSCORES') ? entries.flatMap(([member, score]) => [member, String(score)]) : entries.map(([member]) => member)
      }
      default:
        throw new Error(`fakeRedis: ${name} not supported`)
    }
  }

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).endsWith('/pipeline')) return new Response('not found', { status: 404 })
    const commands = JSON.parse(String(init?.body)) as string[][]
    return Response.json(commands.map((command) => ({ result: run(command) })))
  }) as typeof fetch

  return { fetchImpl, strings, sets, hashes, zsets, lists }
}
