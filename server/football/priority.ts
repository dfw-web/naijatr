/**
 * The only leagues the Football section shows, most important first: the
 * order of the "Watch now" list. Matches from any other league are dropped on
 * the server, which also means the stream provider's request quota is only
 * spent on these. Shared by the browser and the server, so it has no imports.
 */
export const FEATURED_LEAGUES: { id: number; name: RegExp }[] = [
  { id: 39, name: /^(English )?Premier League$/i },
  { id: 140, name: /^(Spanish )?La ?Liga( EA Sports)?$/i },
  { id: 2, name: /^(UEFA )?Champions League$/i },
  { id: 3, name: /^(UEFA )?Europa League$/i },
  { id: 848, name: /^(UEFA )?(Europa )?Conference League$/i },
]

/** Provider league ids are 10 digits; API-Football's are small. */
const isApiFootballLeague = (id: number) => id < 1_000_000

/**
 * 0 for the most important league, FEATURED_LEAGUES.length for any other. By
 * id when it's API-Football's (another country's league can share a name), by
 * name for the provider's (its league ids are its own).
 */
export function leagueRank(league: { id?: number; name?: string } | undefined): number {
  const id = league?.id ?? 0
  const name = (league?.name ?? '').trim()
  const index = FEATURED_LEAGUES.findIndex((l) => (id && isApiFootballLeague(id) ? l.id === id : l.name.test(name)))
  return index === -1 ? FEATURED_LEAGUES.length : index
}

export const isFeaturedLeague = (league: { id?: number; name?: string } | undefined) =>
  leagueRank(league) < FEATURED_LEAGUES.length
