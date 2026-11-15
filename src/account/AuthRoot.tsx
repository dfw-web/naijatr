import { useEffect, useState } from 'react'
import { Analytics } from '@vercel/analytics/react'
import { analyticsBeforeSend } from '../analytics'
import { AuthConfirmPage, AuthResetPage, SetPasswordPage } from './AccountPages'
import { AuthPage } from './SignInSheet'
import { pageFromPath, pageLoad, type Page } from './pages'
import './account.css'

/**
 * The auth pages' own root (main.tsx): /login, /signup, /auth/confirm,
 * /auth/reset, /auth/set-password. Always a full page load of its own, with
 * no ad script, no ad manager hosts and no popups: just the form
 * (src/ads/authGuard.ts explains why).
 */
export function AuthRoot() {
  const [page, setPage] = useState<Page | null>(() => pageFromPath(window.location.pathname))
  useEffect(() => {
    const follow = () => setPage(pageFromPath(window.location.pathname))
    window.addEventListener('popstate', follow)
    return () => window.removeEventListener('popstate', follow)
  }, [])

  return (
    <div className="account-auth-root">
      <header className="account-auth-root__bar">
        <a
          href="/"
          className="account-auth-root__home"
          onClick={(event) => {
            event.preventDefault()
            pageLoad.assign('/')
          }}
        >
          NAIJA <span>TR</span>
        </a>
      </header>
      <main className="account-auth-root__main">
        {page === 'login' ? (
          <AuthPage tab="login" />
        ) : page === 'signup' ? (
          <AuthPage tab="create" />
        ) : page === 'auth/confirm' ? (
          <AuthConfirmPage />
        ) : page === 'auth/reset' ? (
          <AuthResetPage />
        ) : (
          <SetPasswordPage />
        )}
      </main>
      <Analytics beforeSend={analyticsBeforeSend} />
    </div>
  )
}
