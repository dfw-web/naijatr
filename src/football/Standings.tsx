import { useState, type KeyboardEvent } from 'react'
import { ListOrdered } from 'lucide-react'
import { StatusMessage } from '../components/StatusMessage'
import { describeFootballError, useFootball } from './api'
import { FEATURED_LEAGUES, seasonLabel } from './format'
import { TeamLogo } from './MatchList'
import type { LeagueStandings } from './types'

export function Standings() {
  const [leagueId, setLeagueId] = useState<number>(FEATURED_LEAGUES[0].id)
  const { data, error, season, loading, retry } = useFootball<LeagueStandings[]>(`standings?league=${leagueId}`)
  const league = FEATURED_LEAGUES.find((l) => l.id === leagueId)!
  const tables = data?.[0]?.league.standings.filter((group) => group.length) ?? []

  // Arrow keys move between tabs, as in the WAI-ARIA tabs pattern.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    const index = FEATURED_LEAGUES.findIndex((l) => l.id === leagueId)
    const next = FEATURED_LEAGUES[(index + step + FEATURED_LEAGUES.length) % FEATURED_LEAGUES.length]
    setLeagueId(next.id)
    event.currentTarget.querySelector<HTMLButtonElement>(`#fb-tab-${next.id}`)?.focus()
  }

  return (
    <>
      <div className="fb-tabs" role="tablist" aria-label="Leagues" onKeyDown={onKeyDown}>
        {FEATURED_LEAGUES.map((l) => (
          <button
            key={l.id}
            id={`fb-tab-${l.id}`}
            type="button"
            role="tab"
            className="fb-tab"
            aria-selected={l.id === leagueId}
            aria-controls="fb-standings-panel"
            tabIndex={l.id === leagueId ? 0 : -1}
            onClick={() => setLeagueId(l.id)}
          >
            {l.name}
          </button>
        ))}
      </div>

      <div id="fb-standings-panel" role="tabpanel" aria-labelledby={`fb-tab-${leagueId}`} className="fb-panel">
        {season && <p className="fb-panel__season">{seasonLabel(season)} season</p>}
        {loading ? (
          <TableSkeleton />
        ) : error ? (
          error.reason === 'plan' ? (
            <StatusMessage
              icon={ListOrdered}
              compact
              title={`${league.name} ${season ? `${seasonLabel(season)} ` : ''}standings aren't available`}
              message="Standings for the current season need a paid API-Football plan. Live scores and fixtures still work."
            />
          ) : (
            <StatusMessage
              icon={ListOrdered}
              compact
              tone="error"
              {...describeFootballError(error)}
              action={{ label: 'Try again', onClick: retry }}
            />
          )
        ) : tables.length === 0 ? (
          <StatusMessage icon={ListOrdered} compact title="No standings yet" message="The table appears once the season starts." />
        ) : (
          tables.map((rows) => (
            <div key={rows[0].group} className="fb-table-wrap">
              {tables.length > 1 && <h3 className="fb-table__group">{rows[0].group}</h3>}
              <table className="fb-table">
                <caption className="fb-sr-only">
                  {league.name} {rows[0].group}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col" className="fb-table__team">Team</th>
                    <th scope="col"><abbr title="Played">P</abbr></th>
                    <th scope="col" className="fb-wide"><abbr title="Won">W</abbr></th>
                    <th scope="col" className="fb-wide"><abbr title="Drawn">D</abbr></th>
                    <th scope="col" className="fb-wide"><abbr title="Lost">L</abbr></th>
                    <th scope="col"><abbr title="Goal difference">GD</abbr></th>
                    <th scope="col"><abbr title="Points">Pts</abbr></th>
                    <th scope="col" className="fb-wide">Form</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.team.id} title={row.description ?? undefined}>
                      <td className={`fb-table__rank ${row.description ? 'fb-table__rank--marked' : ''}`}>{row.rank}</td>
                      <th scope="row" className="fb-table__team">
                        <TeamLogo src={row.team.logo} size={20} />
                        <span>{row.team.name}</span>
                      </th>
                      <td>{row.all.played}</td>
                      <td className="fb-wide">{row.all.win}</td>
                      <td className="fb-wide">{row.all.draw}</td>
                      <td className="fb-wide">{row.all.lose}</td>
                      <td>{row.goalsDiff > 0 ? `+${row.goalsDiff}` : row.goalsDiff}</td>
                      <td className="fb-table__pts">{row.points}</td>
                      <td className="fb-wide">
                        <span className="fb-form">
                          {(row.form ?? '').slice(-5).split('').map((result, i) => (
                            <span key={i} className={`fb-form__dot fb-form__dot--${result}`} title={result}>
                              {result}
                            </span>
                          ))}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))
        )}
      </div>
    </>
  )
}

function TableSkeleton() {
  return (
    <div className="fb-table-wrap" aria-hidden="true">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="fb-skeleton-row">
          <div className="skeleton skeleton--text" style={{ width: '1.5rem' }} />
          <div className="skeleton skeleton--text" style={{ width: `${40 + ((i * 11) % 30)}%` }} />
          <div className="skeleton skeleton--text" style={{ width: '2rem', marginLeft: 'auto' }} />
        </div>
      ))}
    </div>
  )
}
