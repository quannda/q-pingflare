import { Hono } from 'hono'
import { eq, desc, and, gte } from 'drizzle-orm'
import { getDb, statusLogs, incidents, monitors } from '../db'
import { requireAuth } from '../middleware/auth'
import { cacheKeys, cached, cacheTtl } from '../cache'
import {
  avgResponseMs,
  checkCount,
  dailySeries,
  loadSettings,
  SECONDS_PER_DAY,
  uptimeForDays,
} from '../services/stats'
import type { Db } from '../db'
import type { Env } from '../index'

const router = new Hono<{ Bindings: Env }>()
router.use('*', requireAuth)

/** Guards against a client asking for the whole table in one page. */
const MAX_LOG_LIMIT = 1000
const DEFAULT_SUMMARY_LOGS = 300

function clampLimit(raw: string | undefined, fallback: number): number {
  const n = Number(raw ?? fallback)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.floor(n), MAX_LOG_LIMIT)
}

function recentLogs(db: Db, monitorId: string, limit: number, since: number | null) {
  return db.select()
    .from(statusLogs)
    .where(since !== null
      ? and(eq(statusLogs.monitorId, monitorId), gte(statusLogs.checkedAt, since))
      : eq(statusLogs.monitorId, monitorId))
    .orderBy(desc(statusLogs.checkedAt))
    .limit(limit)
}

function monitorIncidents(db: Db, monitorId: string, limit: number) {
  return db.select()
    .from(incidents)
    .where(eq(incidents.monitorId, monitorId))
    .orderBy(desc(incidents.startedAt))
    .limit(limit)
}

router.get('/:id/logs', async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id')
  const hoursParam = c.req.query('hours')
  const hours = hoursParam !== undefined ? Number(hoursParam) : null
  const limit = clampLimit(c.req.query('limit'), 500)
  const since = hours !== null && hours > 0
    ? Math.floor(Date.now() / 1000) - hours * 3600
    : null

  return c.json(await recentLogs(db, id, limit, since))
})

router.get('/:id/check-count', async (c) => {
  const db = getDb(c.env.DB)
  return c.json({ count: await checkCount(db, c.req.param('id')) })
})

router.get('/:id/incidents', async (c) => {
  const db = getDb(c.env.DB)
  const limit = clampLimit(c.req.query('limit'), 50)
  return c.json(await monitorIncidents(db, c.req.param('id'), limit))
})

router.get('/:id/uptime', async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id')
  const days = Number(c.req.query('days') ?? 90)
  const now = Math.floor(Date.now() / 1000)

  const { uptime, total, ups } = await uptimeForDays(db, id, days, now)
  return c.json({ uptime, days, total, up: ups })
})

router.get('/:id/daily', async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id')
  const days = Number(c.req.query('days') ?? 90)
  const now = Math.floor(Date.now() / 1000)

  const monitor = await db.query.monitors.findFirst({ where: eq(monitors.id, id) })
  if (!monitor) return c.json({ error: 'Not found' }, 404)

  return c.json(await dailySeries(db, id, days, now))
})

/**
 * Everything the monitor detail page needs, in one request. It used to issue
 * nine, each one a full scan of status_logs -- roughly 1.9 billion rows read per
 * hour with a single tab left open.
 *
 * The response is split by freshness: `history` is the expensive long-range
 * aggregation and is KV-cached, while the monitor row, its recent checks and its
 * incidents are always read live so current up/down state is never stale.
 */
router.get('/:id/summary', async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id')
  const now = Math.floor(Date.now() / 1000)
  const logLimit = clampLimit(c.req.query('logs'), DEFAULT_SUMMARY_LOGS)

  const monitor = await db.query.monitors.findFirst({ where: eq(monitors.id, id) })
  if (!monitor) return c.json({ error: 'Not found' }, 404)

  const [logs, incidentRows, allSettings] = await Promise.all([
    recentLogs(db, id, logLimit, null),
    monitorIncidents(db, id, 50),
    loadSettings(db),
  ])

  const history = await cached(c.env, cacheKeys.monitor(id), cacheTtl(allSettings), async () => {
    const [daily, u1, u7, u30, u90, count, avgMs] = await Promise.all([
      dailySeries(db, id, 90, now),
      uptimeForDays(db, id, 1, now),
      uptimeForDays(db, id, 7, now),
      uptimeForDays(db, id, 30, now),
      uptimeForDays(db, id, 90, now),
      checkCount(db, id),
      avgResponseMs(db, id, now - SECONDS_PER_DAY),
    ])
    return {
      daily,
      uptime1: u1.uptime,
      uptime7: u7.uptime,
      uptime30: u30.uptime,
      uptime90: u90.uptime,
      checkCount: count,
      avgResponseMs: avgMs,
    }
  })

  return c.json({ monitor, logs, incidents: incidentRows, ...history })
})

export default router
