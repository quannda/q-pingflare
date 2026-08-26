/**
 * Default refresh cadence for the authenticated views.
 *
 * These pages used to poll every 10s. Each poll fans out into database
 * aggregations, so the interval directly sets the D1 read rate -- and a tab left
 * open in a background window was billing reads nobody was looking at.
 */
export const POLL_INTERVAL_MS = 30_000
export const PUBLIC_POLL_INTERVAL_MS = 60_000

/**
 * Polls `fn` on an interval, skipping ticks while the tab is hidden and doing one
 * immediate refresh when it becomes visible again. Returns the teardown.
 */
export function startPolling(fn: () => unknown, intervalMs = POLL_INTERVAL_MS): () => void {
  const tick = () => {
    if (typeof document !== 'undefined' && document.hidden) return
    void fn()
  }

  const timer = setInterval(tick, intervalMs)
  const onVisibilityChange = () => tick()

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange)
  }

  return () => {
    clearInterval(timer)
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }
}
