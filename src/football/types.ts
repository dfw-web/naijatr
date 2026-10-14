/** The parts of API-Football's response shapes that the Football section uses. */

export interface TeamRef {
  id: number
  name: string
  logo: string
}

export interface FixtureTeam extends TeamRef {
  winner?: boolean | null
}

export interface FixtureStatus {
  long: string
  short: string
  elapsed: number | null
  extra?: number | null
}

export interface Score {
  home: number | null
  away: number | null
}

export interface FixtureEvent {
  time: { elapsed: number; extra: number | null }
  team: TeamRef
  player: { id: number | null; name: string | null }
  assist: { id: number | null; name: string | null }
  type: string
  detail: string
  comments: string | null
}

export interface LineupPlayer {
  player: { id: number; name: string; number: number | null; pos: string | null }
}

export interface Lineup {
  team: TeamRef
  formation: string | null
  startXI: LineupPlayer[]
  substitutes: LineupPlayer[]
  coach: { id: number | null; name: string | null } | null
}

export interface TeamStatistics {
  team: TeamRef
  statistics: { type: string; value: number | string | null }[]
}

export interface Fixture {
  fixture: {
    id: number
    date: string
    timestamp: number
    referee?: string | null
    venue?: { name: string | null; city: string | null }
    status: FixtureStatus
  }
  league: {
    id: number
    name: string
    country: string
    logo: string
    flag?: string | null
    round?: string
    season?: number
  }
  teams: { home: FixtureTeam; away: FixtureTeam }
  goals: Score
  score?: { halftime?: Score; fulltime?: Score; extratime?: Score; penalty?: Score }
  events?: FixtureEvent[]
  lineups?: Lineup[]
  statistics?: TeamStatistics[]
}

export interface StandingRow {
  rank: number
  team: TeamRef
  points: number
  goalsDiff: number
  group: string
  form: string | null
  description: string | null
  all: { played: number; win: number; draw: number; lose: number }
}

export interface LeagueStandings {
  league: { id: number; name: string; standings: StandingRow[][] }
}

export interface Season {
  year: number
  start?: string
  end?: string
}

/** Our /api/football/stream answer (see server/football/stream.ts). */
export interface StreamSource {
  label: string
  url: string
  kind: 'embed' | 'hls' | 'link'
}

export interface CommentaryLine {
  minute: string | null
  text: string
}

export interface MatchStream {
  available: boolean
  streams: StreamSource[]
  commentary: CommentaryLine[]
}
