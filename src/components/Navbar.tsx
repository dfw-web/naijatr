import { useEffect, useRef, useState } from 'react'
import { Menu, Search, X } from 'lucide-react'
import type { NavLink } from '../navigation'
import { isTvMode } from '../tv/tvMode'
import { InstallAppButton } from './InstallApp'
import { TelegramHeaderLink, TelegramMenuLink } from './Telegram'
import { InviteButton } from '../referral/Invite'
import './Navbar.css'

interface NavbarProps {
  links: NavLink[]
  /** Id of the link for the current page, or null when none applies (e.g. searching). */
  activeId: string | null
  query: string
  onQueryChange: (query: string) => void
  onNavigate: (link: NavLink) => void
}

export function Navbar({ links, activeId, query, onQueryChange, onNavigate }: NavbarProps) {
  const [isScrolled, setIsScrolled] = useState(false)
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  // TV: moving onto the search box mustn't pop up the on-screen keyboard, so
  // it stays read-only until OK is pressed on it.
  const tv = isTvMode()
  const [typing, setTyping] = useState(false)
  const refocusing = useRef(false)

  useEffect(() => {
    const onScroll = () => setIsScrolled(window.scrollY > 24)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const navigate = (link: NavLink) => {
    setIsMenuOpen(false)
    onNavigate(link)
  }

  return (
    <header className={`navbar ${isScrolled || isMenuOpen ? 'navbar--solid' : ''}`}>
      <div className="navbar__inner">
        <button
          type="button"
          className="navbar__menu-toggle"
          aria-label={isMenuOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={isMenuOpen}
          aria-controls="primary-navigation"
          onClick={() => setIsMenuOpen((open) => !open)}
        >
          {isMenuOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
        </button>

        <button type="button" className="navbar__logo" onClick={() => navigate(links[0])}>
          <img src="/favicon.svg" alt="" className="brand-mark" /> NAIJA TR
        </button>

        <nav
          id="primary-navigation"
          className={`navbar__links ${isMenuOpen ? 'navbar__links--open' : ''}`}
          aria-label="Primary"
        >
          {links.map((link) => (
            <button
              key={link.id}
              type="button"
              className={`navbar__link ${link.id === activeId ? 'navbar__link--active' : ''}`}
              aria-current={link.id === activeId ? 'page' : undefined}
              onClick={() => navigate(link)}
            >
              {link.label}
            </button>
          ))}
          <TelegramMenuLink />
        </nav>

        <form
          className="navbar__search"
          role="search"
          onSubmit={(event) => event.preventDefault()}
        >
          <Search className="navbar__search-icon" aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder={tv ? 'Search: press OK to type' : 'Search titles, genres, years'}
            aria-label="Search titles"
            readOnly={tv && !typing}
            onChange={(event) => onQueryChange(event.target.value)}
            onClick={() => tv && setTyping(true)}
            onBlur={() => !refocusing.current && setTyping(false)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onQueryChange('')
              if (tv && event.key === 'Enter' && !typing) {
                event.preventDefault()
                setTyping(true)
                // Re-focus once editable, which brings up the TV's keyboard.
                const input = event.currentTarget
                window.setTimeout(() => {
                  refocusing.current = true
                  input.blur()
                  input.focus()
                  refocusing.current = false
                }, 0)
              }
            }}
          />
          {query && (
            <button
              type="button"
              className="navbar__search-clear"
              aria-label="Clear search"
              onClick={() => onQueryChange('')}
            >
              <X aria-hidden="true" />
            </button>
          )}
        </form>

        <InviteButton />

        <TelegramHeaderLink />

        <InstallAppButton className="navbar__install navbar__install--download" />
      </div>
    </header>
  )
}
