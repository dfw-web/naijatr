import { ArrowUp } from 'lucide-react'
import { isTmdbEnabled } from '../data/provider'
import type { NavLink } from '../navigation'
import { TelegramFooter } from './Telegram'
import './Footer.css'

const CURRENT_YEAR = new Date().getFullYear()

interface FooterProps {
  links: NavLink[]
  onNavigate: (link: NavLink) => void
  onBackToTop: () => void
}

export function Footer({ links, onNavigate, onBackToTop }: FooterProps) {
  return (
    <footer className="footer">
      <div className="footer__inner">
        <div className="footer__brand">
          <button type="button" className="footer__logo" onClick={() => onNavigate(links[0])}>
            <img src="/favicon.svg" alt="" className="brand-mark" /> NAIJA TR
          </button>
          <p className="footer__tagline">
            Stories worth staying up for. Discover films and series in one place.
          </p>
          <TelegramFooter />
        </div>

        <nav className="footer__nav" aria-label="Footer">
          <h2 className="footer__heading">Browse</h2>
          <ul>
            {links.map((link) => (
              <li key={link.id}>
                <button type="button" onClick={() => onNavigate(link)}>
                  {link.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="footer__about">
          <h2 className="footer__heading">Data &amp; images</h2>
          {isTmdbEnabled ? (
            <p>
              Title data and artwork are provided by{' '}
              <a href="https://www.themoviedb.org" target="_blank" rel="noreferrer">
                TMDB
              </a>
              . This product uses the TMDB API but is not endorsed or certified by TMDB.
            </p>
          ) : (
            <p>
              Showing a fictional sample catalogue. Images are provided by{' '}
              <a href="https://picsum.photos" target="_blank" rel="noreferrer">
                Lorem Picsum
              </a>{' '}
              under the{' '}
              <a href="https://unsplash.com/license" target="_blank" rel="noreferrer">
                Unsplash licence
              </a>
              .
            </p>
          )}
        </div>
      </div>

      <div className="footer__bottom">
        <p>© {CURRENT_YEAR} NAIJA TR. All rights reserved.</p>
        <button type="button" className="footer__top" onClick={onBackToTop}>
          Back to top <ArrowUp aria-hidden="true" />
        </button>
      </div>
    </footer>
  )
}
