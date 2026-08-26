import { and, eq, lt } from 'drizzle-orm'
import { getDb, monitors, statusLogs, heartbeatTokens, settings, statusPages } from './db'
import { checkHttp } from './services/checker'
import { checkHeartbeat } from './services/heartbeat-checker'
import { processAlert } from './services/alert-manager'
import { dayOf, loadSettings, pruneDailyStats, recordCheck, SECONDS_PER_DAY } from './services/stats'
import { cacheKeys, invalidate } from './cache'
import type { Db } from './db'
import type { Env } from './index'

async function getWorkerOrigin(): Promise<{ colo: string; countryCode: string; originIp: string } | null> {
  try {
    const res = await fetch('https://1.1.1.1/cdn-cgi/trace', { signal: AbortSignal.timeout(3000) })
    const text = await res.text()
    const colo = text.match(/^colo=(.+)$/m)?.[1] ?? null
    const loc  = text.match(/^loc=(.+)$/m)?.[1] ?? null
    const ip   = text.match(/^ip=(.+)$/m)?.[1] ?? ''
    if (!colo || !loc) return null
    return { colo, countryCode: loc, originIp: ip }
  } catch {
    return null
  }
}

function intSetting(all: Record<string, string>, key: string, fallback: number): number {
  const n = Number(all[key])
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/**
 * Retention used to run on every cron tick as a single
 * `DELETE ... WHERE checked_at < cutoff`. With no index on checked_at that was a
 * full table scan every minute -- on its own close to a billion rows read per
 * day. Now it runs at most once a day and deletes per monitor so the
 * (monitor_id, checked_at) index can seek instead of scan.
 */
async function runRetention(db: Db, all: Record<string, string>, now: number): Promise<void> {
  const lastRun = Number(all['last_cleanup_at'] ?? 0)
  if (Number.isFinite(lastRun) && now - lastRun < SECONDS_PER_DAY) return

  // Claimed before the work so overlapping invocations do not all run it.
  await db.insert(settings)
    .values({ key: 'last_cleanup_at', value: String(now) })
    .onConflictDoUpdate({ target: settings.key, set: { value: String(now) } })

  // Every monitor, not just the active ones -- a paused monitor's logs still
  // need to age out.
  const ids = await db.select({ id: monitors.id }).from(monitors)

  const logCutoff = now - intSetting(all, 'retention_days', 90) * SECONDS_PER_DAY
  for (const { id } of ids) {
    await db.delete(statusLogs)
      .where(and(eq(statusLogs.monitorId, id), lt(statusLogs.checkedAt, logCutoff)))
  }

  await pruneDailyStats(db, dayOf(now) - intSetting(all, 'stats_retention_days', 400))
}

export async function runCron(env: Env): Promise<void> {
  const db = getDb(env.DB)
  const now = Math.floor(Date.now() / 1000)

  const allSettings = await loadSettings(db)
  const locale = allSettings['locale'] ?? 'en'

  await runRetention(db, allSettings, now)

  const allMonitors = await db.select()
    .from(monitors)
    .where(eq(monitors.active, true))

  const due = allMonitors.filter(m => {
    if (!m.lastCheckedAt) return true
    return (now - m.lastCheckedAt) >= m.interval
  })

  if (due.length === 0) return

  const origin = await getWorkerOrigin()

  // Monitors whose up/down state flipped this run. Only these need their cached
  // aggregates dropped -- invalidating on every tick would defeat the cache.
  const transitioned: string[] = []

  await Promise.allSettled(due.map(async (monitor) => {
    const logRow = {
      id: crypto.randomUUID(),
      monitorId: monitor.id,
      checkedAt: now,
      colo: origin?.colo ?? null,
      countryCode: origin?.countryCode ?? null,
      originIp: origin?.originIp ?? null,
    }

    try {
      if (monitor.type === 'http') {
        const result = await checkHttp(monitor, locale)

        await db.insert(statusLogs).values({
          ...logRow,
          status: result.status,
          message: result.message,
          responseTimeMs: result.responseTimeMs,
        })
        await recordCheck(db, monitor.id, now, result.status, result.responseTimeMs ?? null)

        if (monitor.lastStatus !== result.status) transitioned.push(monitor.id)

        if (monitor.sslCheckEnabled && monitor.url?.startsWith('https://')) {
          const newSslStatus = result.sslError ? 'error' : (result.status === 'up' ? 'ok' : monitor.sslStatus)
          if (newSslStatus !== monitor.sslStatus) {
            await db.update(monitors).set({ sslStatus: newSslStatus }).where(eq(monitors.id, monitor.id))
          }
        }

        await processAlert({
          db,
          monitor,
          status: result.status,
          message: result.message,
          responseTimeMs: result.responseTimeMs,
          locale,
          encryptionKey: env.ENCRYPTION_KEY,
        })

      } else if (monitor.type === 'heartbeat') {
        const hb = await db.query.heartbeatTokens.findFirst({
          where: eq(heartbeatTokens.monitorId, monitor.id),
        })

        const result = checkHeartbeat(monitor, hb?.lastPingAt ?? null, now, locale)

        await db.insert(statusLogs).values({
          ...logRow,
          status: result.status,
          message: result.logKey ?? result.message,
          responseTimeMs: null,
        })
        await recordCheck(db, monitor.id, now, result.status, null)

        if (monitor.lastStatus !== result.status) transitioned.push(monitor.id)

        await processAlert({
          db,
          monitor,
          status: result.status,
          message: result.message,
          locale,
          encryptionKey: env.ENCRYPTION_KEY,
        })
      }
    } catch (err) {
      await db.insert(statusLogs).values({
        ...logRow,
        status: 'down',
        message: `Internal error: ${String(err)}`,
        responseTimeMs: null,
      }).catch(() => {})
      await recordCheck(db, monitor.id, now, 'down', null).catch(() => {})
    }
  }))

  if (transitioned.length > 0) {
    await invalidate(env, cacheKeys.overview(), ...transitioned.map(cacheKeys.monitor))
    await invalidatePublicPages(db, env, transitioned)
  }
}

/** Only reached on a status transition, so the extra reads are rare. */
async function invalidatePublicPages(db: Db, env: Env, monitorIds: string[]): Promise<void> {
  try {
    const pages = await db.select({ slug: statusPages.slug }).from(statusPages)
    const keys = pages.flatMap(p => [
      cacheKeys.publicPage(p.slug),
      ...monitorIds.map(id => cacheKeys.publicMonitor(p.slug, id)),
    ])
    await invalidate(env, ...keys)
  } catch (err) {
    console.error('[cron] status page cache invalidation failed', err)
  }
}
