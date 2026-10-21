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
        hash.set(args[1], args[2])
        return 1
      }
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
        const entries = [...(zsets.get(key) ?? [])].sort((a, b) => a[1] - b[1])
        if (args.map((a) => a.toUpperCase()).includes('REV')) entries.reverse()
        return entries.flatMap(([member, score]) => [member, String(score)])
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
