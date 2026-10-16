import { useCallback } from 'react'
import type { SyntheticEvent } from 'react'
import { openAd } from '../ads/directLink'
import { ADS_ENABLED } from '../config/ads'
import type { MediaItem } from '../types/media'

/** Ad key for a title: its details page shows the ad break if the ad was blocked. */
export const titleAdKey = (item: Pick<MediaItem, 'type' | 'id'>) => `title:${item.type}:${item.id}`

/**
 * Returns a function that opens the ad in a new tab, once per tap. Call it
 * first thing in the click handler, before onSelect or anything async: Safari
 * only allows the new tab inside the tap itself. It never touches the current
 * tab, so the click's own action carries on as normal. Does nothing while
 * ADS_ENABLED is false.
 */
export function useAdOnce() {
  return useCallback((event: SyntheticEvent, item: Pick<MediaItem, 'type' | 'id'>) => {
    if (!ADS_ENABLED) return
    openAd(event.nativeEvent, titleAdKey(item))
  }, [])
}
