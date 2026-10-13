import type { WatchProvider, WatchProviders as Providers } from '../types/media'
import './WatchProviders.css'

const REGION_NAMES: Record<string, string> = { NG: 'Nigeria', US: 'the United States' }

const GROUPS: { key: 'stream' | 'free' | 'rent' | 'buy'; label: string }[] = [
  { key: 'stream', label: 'Stream' },
  { key: 'free', label: 'Free' },
  { key: 'rent', label: 'Rent' },
  { key: 'buy', label: 'Buy' },
]

/** TMDB "Where to watch" list. Provider data comes from JustWatch, which TMDB requires us to credit. */
export function WatchProviders({ providers }: { providers: Providers }) {
  const region = REGION_NAMES[providers.region] ?? providers.region
  return (
    <section className="providers" aria-label="Where to watch">
      <h3 className="providers__title">Where to watch in {region}</h3>
      {GROUPS.filter((g) => providers[g.key].length > 0).map((g) => (
        <div key={g.key} className="providers__group">
          <span className="providers__label">{g.label}</span>
          <ul className="providers__list">
            {providers[g.key].map((p: WatchProvider) => (
              <li key={p.id} title={p.name}>
                {p.logo ? <img src={p.logo} alt={p.name} loading="lazy" /> : <span>{p.name}</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <p className="providers__credit">
        {providers.link ? (
          <a href={providers.link} target="_blank" rel="noopener noreferrer">
            See all options on TMDB
          </a>
        ) : null}{' '}
        Data from JustWatch.
      </p>
    </section>
  )
}
