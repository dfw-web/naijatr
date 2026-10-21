import { useEffect, useMemo, useState } from 'react'
import { useCatalogProvider } from '../data/provider'
import type { MediaItem } from '../types/media'
import { interleave, rankByTaste, varietySize, type PersonalPlan, type PlannedRow, ROW_LIMIT } from './personalHome'
import { attributeScores, readTaste } from './profile'

export interface LoadedRow extends PlannedRow {
  items: MediaItem[]
  loading: boolean
}

/**
 * Loads the planned rows' lists once `active` (the rows are near the screen),
 * all at once so they can be de-duplicated together. A failed list is just an
 * empty row (hidden by the caller); nothing here can break the home screen.
 */
export function usePersonalRows(plan: PersonalPlan | null, active: boolean) {
  const provider = useCatalogProvider()
  const [loaded, setLoaded] = useState<{ plan: PersonalPlan; rows: Map<string, MediaItem[]> } | null>(null)

  useEffect(() => {
    if (!plan || !active || !provider.listTmdb) return
    const list = provider.listTmdb.bind(provider)
    const controller = new AbortController()
    const rows = [...plan.top, ...(plan.variety ? [plan.variety] : [])]
    const scores = attributeScores(readTaste())
    void Promise.all(
      rows.map(async (row) => {
        const lists = await Promise.all(
          row.requests.map((r) => list(r.path, r.params, r.type, controller.signal).catch(() => [] as MediaItem[])),
        )
        return { row, lists }
      }),
    ).then((results) => {
      if (controller.signal.aborted) return
      const out = new Map<string, MediaItem[]>()
      let personal = 0
      for (const { row, lists } of results) {
        if (row.kind === 'variety') continue
        const items = rankByTaste(lists, scores).slice(0, ROW_LIMIT * 2)
        personal += Math.min(items.length, ROW_LIMIT)
        out.set(row.id, items)
      }
      const variety = results.find((r) => r.row.kind === 'variety')
      // Extra, so de-duplication still leaves enough.
      if (variety) out.set(variety.row.id, interleave(variety.lists, varietySize(personal) * 2))
      setLoaded({ plan, rows: out })
    })
    return () => controller.abort()
  }, [plan, active, provider])

  return useMemo(() => {
    const ready = loaded?.plan === plan ? loaded.rows : null
    const fill = (row: PlannedRow): LoadedRow => ({ ...row, items: ready?.get(row.id) ?? [], loading: !ready })
    return {
      top: plan?.top.map(fill) ?? [],
      variety: plan?.variety ? fill(plan.variety) : null,
      varietyLimit: ready ? varietySize([...ready].filter(([id]) => id !== plan?.variety?.id).reduce((n, [, items]) => n + Math.min(items.length, ROW_LIMIT), 0)) : 0,
    }
  }, [loaded, plan])
}

/** True once `element` is within a screen of the viewport (at once where IntersectionObserver is missing). */
export function useNearScreen(element: Element | null) {
  const supported = typeof IntersectionObserver !== 'undefined'
  const [near, setNear] = useState(false)
  useEffect(() => {
    if (near || !element || !supported) return
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), {
      rootMargin: '100% 0px',
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [element, near, supported])
  return near || !supported
}
