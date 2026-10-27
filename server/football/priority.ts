/**
 * The featured leagues, most important first: the order of the "Watch now"
 * list and of the league groups (any other league follows, by country). Every
 * league's matches are shown; the requests made per league or per match (the
 * schedule, stream link checks) are only spent on these. Shared by the browser
 * and the server, so it has no imports.
 */
export const FEATURED_LEAGUES: { id: number; name: RegExp }[] = [
  // The Live Streaming API files some matches under a second name ("Spain La Liga" as well as "Spanish La Liga").
  { id: 39, name: /^(English |England )?Premier League$/i },
  { id: 140, name: /^(Spanish |Spain )?La ?Liga( EA Sports)?$/i },
  { id: 2, name: /^(UEFA )?Champions League$/i },
  { id: 3, name: /^(UEFA )?Europa League$/i },
  { id: 848, name: /^(UEFA )?(Europa )?Conference League$/i },
  { id: 307, name: /^(Saudi (Arabia )?)?(Professional|Pro) League$/i },
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
