/**
 * Optional KV-backed cache for the expensive historical aggregates.
 *
 * Sized for the KV free tier, where writes are the binding constraint:
 * 100,000 reads/day but only 1,000 writes/day and 1,000 deletes/day. A write
 * only happens on a miss, so the write rate per key is 86400 / ttl. At the
 * default 900s TTL that is 96 writes/day/key, which leaves room for ~10 hot
 * keys (the overview, a handful of monitor detail pages, a status page or two).
 *
 * Deliberately NOT cached: anything reflecting current up/down state. Those
 * reads come from the `monitors` table, which is one row per monitor and costs
 * nothing to read fresh. Staleness on a monitoring dashboard is worse than a
 * few thousand D1 row reads.
 *
 * Every operation degrades to a direct compute if KV is unbound (self-hosted
 * Node mode, or before the namespace is created) or if KV errors -- including
 * hitting the daily write cap, which surfaces as a failed put.
 */

export interface CacheBinding {
  CACHE?: KVNamespace
}

/** KV rejects an expirationTtl below 60. */
const MIN_TTL = 60
const DEFAULT_TTL = 900

export function cacheTtl(settings: Record<string, string>): number {
  const raw = Number(settings['cache_ttl'])
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TTL
  return Math.max(MIN_TTL, Math.floor(raw))
}

export async function cached<T>(
  env: CacheBinding,
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>,
): Promise<T> {
  const kv = env.CACHE
  if (!kv) return compute()

  try {
    const hit = await kv.get<T>(key, 'json')
    if (hit !== null) return hit
  } catch (err) {
    console.error('[cache] read failed', key, err)
  }

  const value = await compute()

  try {
    await kv.put(key, JSON.stringify(value), {
      expirationTtl: Math.max(MIN_TTL, ttlSeconds),
    })
  } catch (err) {
    // Most likely the daily write cap. Serving the fresh value is still correct.
    console.error('[cache] write failed', key, err)
  }

  return value
}

export async function invalidate(env: CacheBinding, ...keys: string[]): Promise<void> {
  const kv = env.CACHE
  if (!kv || keys.length === 0) return
  await Promise.allSettled(keys.map(k => kv.delete(k).catch(() => {})))
}

/**
 * Cache keys. The `v1` segment lets a shape change invalidate every entry at
 * once by bumping it, rather than spending KV deletes.
 */
export const cacheKeys = {
  overview: () => 'agg:v1:overview',
  monitor: (id: string) => `agg:v1:monitor:${id}`,
  publicPage: (slug: string) => `agg:v1:public:${slug}`,
  publicMonitor: (slug: string, monitorId: string) => `agg:v1:public:${slug}:${monitorId}`,
}

/** Everything derived from one monitor's history, dropped when that history changes. */
export function monitorKeys(monitorId: string, slugs: string[] = []): string[] {
  return [
    cacheKeys.overview(),
    cacheKeys.monitor(monitorId),
    ...slugs.flatMap(s => [cacheKeys.publicPage(s), cacheKeys.publicMonitor(s, monitorId)]),
  ]
}
