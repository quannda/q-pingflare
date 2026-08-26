import { Hono } from 'hono'
import { eq, desc, and, inArray } from 'drizzle-orm'
import { getDb, statusPages, statusPageMonitors, monitors, statusLogs, incidents, incidentReports, incidentUpdates, incidentMonitors } from '../db'
import { verifyPassword } from '../utils'
import { cacheKeys, cached, cacheTtl } from '../cache'
import {
  SECONDS_PER_DAY,
  avgResponseMs,
  dailySeries,
  dailySeriesBulk,
  loadSettings,
  uptimeBulk,
  uptimeForDays,
} from '../services/stats'
import type { Db } from '../db'
import type { Env } from '../index'

const router = new Hono<{ Bindings: Env }>()

const PUBLIC_LOG_LIMIT = 200

async function checkPassword(
  page: { passwordHash: string | null },
  provided: string | undefined,
): Promise<'ok' | 'password_required' | 'wrong_password'> {
  if (!page.passwordHash) return 'ok'
  if (!provided) return 'password_required'
  return (await verifyPassword(provided, page.passwordHash)) ? 'ok' : 'wrong_password'
}

async function resolveMonitors(db: Db, page: { id: string; showAllMonitors: boolean }) {
  if (page.showAllMonitors) {
    const rows = await db.select().from(monitors).where(eq(monitors.active, true))
    rows.sort((a, b) => a.name.localeCompare(b.name))
    return { ids: rows.map(r => r.id), rows }
  }

  const pageMonitorRows = await db.select().from(statusPageMonitors)
    .where(eq(statusPageMonitors.pageId, page.id))
  pageMonitorRows.sort((a, b) => a.sortOrder - b.sortOrder)
  const ids = pageMonitorRows.map(r => r.monitorId)

  if (ids.length === 0) return { ids, rows: [] }

  const rows = await db.select().from(monitors).where(inArray(monitors.id, ids))
  return { ids, rows }
}

router.get('/:slug', async (c) => {
  const db = getDb(c.env.DB)
  const slug = c.req.param('slug')

  const page = await db.query.statusPages.findFirst({ where: eq(statusPages.slug, slug) })
  if (!page) return c.json({ error: 'Not found' }, 404)

  const pageInfo = { name: page.name, description: page.description }
  const auth = await checkPassword(page, c.req.header('x-status-password') ?? c.req.query('password'))
  if (auth !== 'ok') return c.json({ error: auth, protected: true, page: pageInfo }, 401)

  const now = Math.floor(Date.now() / 1000)
  const { ids: monitorIds, rows: monitorRows } = await resolveMonitors(db, page)

  if (monitorIds.length === 0) {
    return c.json({
      page: { ...pageInfo, protected: !!page.passwordHash },
      monitors: [],
      incidents: [],
    })
  }

  const allSettings = await loadSettings(db)

  // Only the 90-day history is cached. Current up/down comes from the monitor
  // rows read above, so the badges stay live even on a cache hit.
  const history = await cached(c.env, cacheKeys.publicPage(slug), cacheTtl(allSettings), async () => {
    const [daily, uptime] = await Promise.all([
      dailySeriesBulk(db, monitorIds, 90, now),
      uptimeBulk(db, monitorIds, 90, now),
    ])
    return {
      daily: Object.fromEntries(daily),
      uptime90d: Object.fromEntries([...uptime].map(([id, t]) => [id, t.uptime])),
      incidents: await publicIncidents(db, monitorIds, now),
    }
  })

  const byId = new Map(monitorRows.map(m => [m.id, m]))
  const monitorData = monitorIds
    .map(id => {
      const m = byId.get(id)
      if (!m) return null
      return {
        id: m.id,
        name: m.name,
        status: m.lastStatus,
        uptime90d: history.uptime90d[id] ?? null,
        daily: history.daily[id] ?? [],
      }
    })
    .filter((m): m is NonNullable<typeof m> => m !== null)

  return c.json({
    page: { ...pageInfo, protected: !!page.passwordHash },
    monitors: monitorData,
    incidents: history.incidents,
  })
})

/** Published incident reports touching any of these monitors, last 14 days. */
async function publicIncidents(db: Db, monitorIds: string[], now: number) {
  const incMonitorRows = await db.select().from(incidentMonitors)
    .where(inArray(incidentMonitors.monitorId, monitorIds))
  const incidentIds = [...new Set(incMonitorRows.map(r => r.incidentId))]
  if (incidentIds.length === 0) return []

  const since14d = now - 14 * SECONDS_PER_DAY
  const incRows = await db.select().from(incidentReports)
    .where(inArray(incidentReports.id, incidentIds))
    .orderBy(desc(incidentReports.startedAt))
    .limit(20)

  const visible = incRows.filter(inc => !(inc.resolvedAt && inc.resolvedAt < since14d))
  if (visible.length === 0) return []

  // One query for every incident's updates instead of one query per incident.
  const updateRows = await db.select().from(incidentUpdates)
    .where(inArray(incidentUpdates.incidentId, visible.map(i => i.id)))
    .orderBy(desc(incidentUpdates.createdAt))

  return visible.map(inc => ({
    ...inc,
    updates: updateRows.filter(u => u.incidentId === inc.id),
    monitorIds: incMonitorRows.filter(r => r.incidentId === inc.id).map(r => r.monitorId),
  }))
}

router.get('/:slug/monitors/:monitorId', async (c) => {
  const db = getDb(c.env.DB)
  const slug = c.req.param('slug')
  const monitorId = c.req.param('monitorId')

  const page = await db.query.statusPages.findFirst({ where: eq(statusPages.slug, slug) })
  if (!page) return c.json({ error: 'Not found' }, 404)

  const auth = await checkPassword(page, c.req.header('x-status-password') ?? c.req.query('password'))
  if (auth !== 'ok') return c.json({ error: auth, protected: true }, 401)

  let monitor: typeof monitors.$inferSelect | undefined
  if (page.showAllMonitors) {
    monitor = await db.query.monitors.findFirst({
      where: and(eq(monitors.id, monitorId), eq(monitors.active, true)),
    })
  } else {
    const rows = await db.select().from(statusPageMonitors)
      .where(and(eq(statusPageMonitors.pageId, page.id), eq(statusPageMonitors.monitorId, monitorId)))
    if (rows.length > 0) {
      monitor = await db.query.monitors.findFirst({ where: eq(monitors.id, monitorId) })
    }
  }
  if (!monitor) return c.json({ error: 'Not found' }, 404)

  const now = Math.floor(Date.now() / 1000)
  const allSettings = await loadSettings(db)

  const [logs, monitorIncidents] = await Promise.all([
    db.select().from(statusLogs)
      .where(eq(statusLogs.monitorId, monitorId))
      .orderBy(desc(statusLogs.checkedAt))
      .limit(PUBLIC_LOG_LIMIT),
    db.select().from(incidents)
      .where(eq(incidents.monitorId, monitorId))
      .orderBy(desc(incidents.startedAt))
      .limit(20),
  ])

  const history = await cached(
    c.env,
    cacheKeys.publicMonitor(slug, monitorId),
    cacheTtl(allSettings),
    async () => {
      const [daily, u1, u7, u30, u90, avgMs] = await Promise.all([
        dailySeries(db, monitorId, 90, now),
        uptimeForDays(db, monitorId, 1, now),
        uptimeForDays(db, monitorId, 7, now),
        uptimeForDays(db, monitorId, 30, now),
        uptimeForDays(db, monitorId, 90, now),
        avgResponseMs(db, monitorId, now - SECONDS_PER_DAY),
      ])
      return {
        daily,
        uptime1: u1.uptime,
        uptime7: u7.uptime,
        uptime30: u30.uptime,
        uptime90: u90.uptime,
        avgResponseMs: avgMs,
      }
    },
  )

  return c.json({
    name: monitor.name,
    type: monitor.type,
    url: monitor.url,
    tags: monitor.tags,
    lastStatus: monitor.lastStatus,
    lastCheckedAt: monitor.lastCheckedAt,
    ...history,
    logs: logs.map(l => ({
      checkedAt: l.checkedAt,
      status: l.status,
      responseTimeMs: l.responseTimeMs,
      message: l.message,
    })),
    incidents: monitorIncidents.map(i => ({
      startedAt: i.startedAt,
      resolvedAt: i.resolvedAt,
      durationSeconds: i.durationSeconds,
    })),
  })
})

export default router
