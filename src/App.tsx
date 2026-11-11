import { useCallback, useEffect, useState } from 'react'
import { Analytics } from '@vercel/analytics/react'
import { AdsBackNotice } from './ads/AdsBackNotice'
import { AdUpsell } from './ads/AdUpsell'
import { rememberNoAdsFlag } from './ads/directLink'
import { useMultitag } from './ads/monetag'
import { AD_SECTIONS } from './config/ads'
import { analyticsBeforeSend } from './analytics'
import { BrowseView } from './components/BrowseView'
import { DetailsModal } from './components/DetailsModal'
import { FallbackNotice } from './components/FallbackNotice'
import { Footer } from './components/Footer'
import { HomeView } from './components/HomeView'
import { Navbar } from './components/Navbar'
import { SearchResults } from './components/SearchResults'
import { DEFAULT_FILTERS, hasNarrowingFilters } from './config/discoverFilters'
import { useFilterParams } from './hooks/useFilterParams'
import { TvAdBreakHost } from './tv/TvAdBreak'
import { TelegramGateHost } from './gate/TelegramGate'
import { GreetingHost } from './components/Greeting'
import { InstallAppHost } from './components/InstallApp'
import { FeedbackHost } from './feedback/Feedback'
import { ActivationNoticeHost, DailyPromoHost, InvitePage, InviteRulesPage, RenewReminderHost, UnlockNoticeHost } from './referral/Invite'
import { hashForView, NAV_LINKS, type NavLink, type View, viewFromHash } from './navigation'
import type { MediaItem } from './types/media'
import { AccountPage, AuthConfirmPage, AuthResetPage, MyListPage, PrivacyPage } from './account/AccountPages'
import { pageFromPath, type Page } from './account/pages'
import { SignInHost } from './account/SignInSheet'
import { PromoWeekBanner, PromoWeekEndedHost, PromoWeekWelcomeHost } from './promo/PromoWeek'
import { TrialEndedHost, TrialPromptHost, TrialWelcomeHost } from './promo/WelcomeTrial'
import { loadPromo } from './referral/status'
import { PasswordReminderHost, SyncPromptHost } from './account/SyncPrompt'
import './App.css'

const TRENDING_LINK: NavLink = { ...NAV_LINKS[0], section: 'trending' }

/**
 * A title opened from a link (?title=movie-550 or ?title=series-1399, e.g. the
 * TV's "watch on your phone" QR code). Only the id is known; the details
 * panel fills in the rest.
 */
function titleFromUrl(search = window.location.search): MediaItem | null {
  const match = /^(movie|series)-([1-9]\d{0,9})$/.exec(new URLSearchParams(search).get('title') ?? '')
  if (!match) return null
  const type = match[1] as MediaItem['type']
  const tmdbId = Number(match[2])
  return {
    id: `tmdb-${type}-${tmdbId}`,
    tmdbId,
    type,
    title: '',
    year: null,
    releaseDate: null,
    genres: [],
    score: 0,
    voteCount: 0,
    popularity: 0,
    description: '',
    poster: null,
    backdrop: null,
  }
}

/** Drops the link's ?title= (and its tracking tag) once the panel closes, so a reload doesn't reopen it. */
function forgetTitleLink() {
  const url = new URL(window.location.href)
  if (!url.searchParams.has('title')) return
  url.searchParams.delete('title')
  url.searchParams.delete('utm_source')
  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
}

function App() {
  // Before useFilterParams rewrites the query string.
  useState(() => rememberNoAdsFlag())
  const [view, setView] = useState<View>(() => viewFromHash(window.location.hash))
  // /my-list, /account, /privacy: shown instead of the views.
  const [page, setPage] = useState<Page | null>(() => pageFromPath(window.location.pathname))
  // The Monetag Multitag, once (after the ?noads= check above), while the movie section has ads;
  // not while setting a password from an email link, but as soon as they move on.
  useMultitag(AD_SECTIONS.movies && page !== 'auth/confirm' && page !== 'auth/reset' && page !== 'account' && page !== 'privacy')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<MediaItem | null>(titleFromUrl)
  // Wrapped in an object so clicking the same link twice still scrolls.
  const [scrollRequest, setScrollRequest] = useState<{ section: string | null } | null>(null)
  // Bumped by "Try again" to remount the views, which re-runs every request.
  const [refreshKey, setRefreshKey] = useState(0)
  // Browse filters live in the query string (?genre=comedy&industry=nollywood#/movies).
  const { filters, committed, setFilters, reset: resetFilters } = useFilterParams()

  const isSearching = query.trim().length > 0
  // On a browse page with filters, a text search is filtered too (see BrowseView).
  const isFilteredSearch = isSearching && view !== 'home' && hasNarrowingFilters(filters)

  // The Free Ad-Free Week's times, for a signed-out visitor (signed in: with the account's status).
  useEffect(() => loadPromo(), [])

  // Browser Back/Forward between views.
  useEffect(() => {
    const onPopState = () => {
      setView(viewFromHash(window.location.hash))
      setPage(pageFromPath(window.location.pathname))
      setQuery('')
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  // Scroll after render, so the target view/section exists.
  useEffect(() => {
    if (!scrollRequest) return
    const target = scrollRequest.section && document.getElementById(scrollRequest.section)
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }, [scrollRequest])

  const handleNavigate = (link: NavLink) => {
    if (link.href) return window.location.assign(link.href)
    // A new view starts unfiltered, so drop the filter query string too. From an account page: back to /.
    const path = page ? '/' : window.location.pathname
    const url = path + hashForView(link.view)
    if (page || window.location.hash !== hashForView(link.view) || window.location.search) {
      window.history.pushState(null, '', url)
    }
    setPage(null)
    setView(link.view)
    setQuery('')
    resetFilters()
    setScrollRequest({ section: link.section ?? null })
  }

  // From the search's empty state: Movies, filtered to that genre.
  const browseGenre = (genreId: string) => {
    handleNavigate(NAV_LINKS.find((link) => link.view === 'movies')!)
    setFilters({ ...DEFAULT_FILTERS, genres: [genreId] })
  }

  const handleQueryChange = (next: string) => {
    // Starting a new search: jump to the top so results are in view.
    if (!isSearching && next.trim()) window.scrollTo({ top: 0 })
    setQuery(next)
  }

  const closeDetails = useCallback(() => {
    forgetTitleLink()
    setSelected(null)
  }, [])

  const activeId = isSearching && !isFilteredSearch ? null : page ? null : view

  return (
    <>
      <PromoWeekBanner />
      <Navbar
        links={NAV_LINKS}
        activeId={activeId}
        query={query}
        onQueryChange={handleQueryChange}
        onNavigate={handleNavigate}
        onSelect={setSelected}
      />

      <main className="app-main" key={refreshKey}>
        {isSearching && !isFilteredSearch ? (
          <SearchResults
            query={query}
            filters={filters}
            committed={committed}
            onFiltersChange={setFilters}
            onSelect={setSelected}
            onClear={() => setQuery('')}
            onBrowseGenre={browseGenre}
          />
        ) : page === 'my-list' ? (
          <MyListPage onSelect={setSelected} />
        ) : page === 'account' ? (
          <AccountPage />
        ) : page === 'privacy' ? (
          <PrivacyPage />
        ) : page === 'auth/confirm' ? (
          <AuthConfirmPage />
        ) : page === 'auth/reset' ? (
          <AuthResetPage />
        ) : page === 'invite' ? (
          <InvitePage />
        ) : page === 'invite/rules' ? (
          <InviteRulesPage />
        ) : view === 'home' ? (
          <HomeView onSelect={setSelected} onBrowseTrending={() => handleNavigate(TRENDING_LINK)} />
        ) : (
          <BrowseView
            key={view}
            type={view === 'movies' ? 'movie' : 'series'}
            filters={filters}
            committed={committed}
            onFiltersChange={setFilters}
            query={isFilteredSearch ? query : ''}
            onSelect={setSelected}
          />
        )}
      </main>

      <Footer
        links={NAV_LINKS}
        onNavigate={handleNavigate}
        onBackToTop={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      />

      <FallbackNotice onRetry={() => setRefreshKey((n) => n + 1)} />

      {selected && (
        <DetailsModal key={selected.id} item={selected} onClose={closeDetails} onSelect={setSelected} />
      )}
      <TvAdBreakHost />
      <TelegramGateHost />
      {AD_SECTIONS.movies && <AdsBackNotice />}
      <AdUpsell />
      {/* The seasonal greeting (src/config/greetings.ts), after any other popup. */}
      <GreetingHost />
      <InstallAppHost />
      <FeedbackHost />
      {/* Optional accounts: the sign-in sheet, and the gentle reminders (at most weekly, never forced). */}
      <SignInHost />
      <SyncPromptHost />
      <PasswordReminderHost />
      {/* Referrals: the daily "Go ad-free" popup (at most once a day) and the unlock notice. */}
      <DailyPromoHost />
      <UnlockNoticeHost />
      {/* Paid ad-free: "active until…" after a grant, and the renew reminder in its last 3 days. */}
      <ActivationNoticeHost />
      <RenewReminderHost />
      {/* The Free Ad-Free Week's messages (the daily popup and "Ads are back" wait while it's on). */}
      <PromoWeekWelcomeHost />
      <PromoWeekEndedHost />
      {/* The 48-hour Premium welcome trial: the Play popup (signed out), the welcome and the "ended" messages. */}
      <TrialPromptHost />
      <TrialWelcomeHost />
      <TrialEndedHost />

      {/* Vercel Web Analytics: page views, plus route changes via history.pushState. */}
      <Analytics beforeSend={analyticsBeforeSend} />
    </>
  )
}

export default App
