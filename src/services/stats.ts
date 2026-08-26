import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import type { Db } from '../db'
import { dailyStats, statusLogs, settings } from '../db/schema'

export const SECONDS_PER_DAY = 86400

/** UTC day number, matching the buckets stored in daily_stats. */
export function dayOf(unixSeconds: number): number {
  return Math.floor(unixSeconds / SECONDS_PER_DAY)
}

export function dayToDate(day: number): string {
  return new Date(day * SECONDS_PER_DAY * 1000).toISOString().slice(0, 10)
}

export async function loadSettings(db: Db): Promise<Record<string, string>> {
  const rows = await db.select().from(settings)
  const out: Record<string, string> = {}
  for (const row of rows) out[row.key] = row.value
  return out
}

export interface UptimeTotals {
  total: number
  ups: number
  uptime: number | null
}

function toUptime(total: number, ups: number): UptimeTotals {
  return { total, ups, uptime: total > 0 ? Math.round((ups / total) * 10000) / 100 : null }
}

/**
 * Windows of a couple of days are read straight from the raw logs so they stay
 * precise to the second (daily_stats buckets are calendar days, so "last 24h"
 * would otherwise mean "since midnight UTC"). Bounded by the composite index to
 * at most a few thousand rows.
 */
export async function uptimeFromLogs(db: Db, monitorId: string, sinceTs: number): Promise<UptimeTotals> {
  const [row] = await db.select({
    total: sql<number>`COUNT(*)`,
    ups: sql<number>`COALESCE(SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END), 0)`,
  })
    .from(statusLogs)
    .where(and(eq(statusLogs.monitorId, monitorId), gte(statusLogs.checkedAt, sinceTs)))

  return toUptime(Number(row?.total ?? 0), Number(row?.ups ?? 0))
}

/** Long windows read the rollup: 90 rows instead of ~130k raw logs. */
export async function uptimeFromStats(db: Db, monitorId: string, sinceDay: number): Promise<UptimeTotals> {
  const [row] = await db.select({
    total: sql<number>`COALESCE(SUM(total), 0)`,
    ups: sql<number>`COALESCE(SUM(ups), 0)`,
  })
    .from(dailyStats)
    .where(and(eq(dailyStats.monitorId, monitorId), gte(dailyStats.day, sinceDay)))

  return toUptime(Number(row?.total ?? 0), Number(row?.ups ?? 0))
}

export async function uptimeForDays(db: Db, monitorId: string, days: number, now: number): Promise<UptimeTotals> {
  if (days <= 2) return uptimeFromLogs(db, monitorId, now - days * SECONDS_PER_DAY)
  return uptimeFromStats(db, monitorId, dayOf(now) - (days - 1))
}

export interface DailyUptime {
  date: string
  uptime: number | null
}

export async function dailySeries(db: Db, monitorId: string, days: number, now: number): Promise<DailyUptime[]> {
  const today = dayOf(now)
  const fromDay = today - (days - 1)

  const rows = await db.select({
    day: dailyStats.day,
    total: dailyStats.total,
    ups: dailyStats.ups,
  })
    .from(dailyStats)
    .where(and(eq(dailyStats.monitorId, monitorId), gte(dailyStats.day, fromDay)))

  return fillDays(rows, fromDay, today)
}

function fillDays(
  rows: { day: number; total: number; ups: number }[],
  fromDay: number,
  today: number,
): DailyUptime[] {
  const byDay = new Map(rows.map(r => [r.day, r]))
  const out: DailyUptime[] = []
  for (let d = fromDay; d <= today; d++) {
    const row = byDay.get(d)
    out.push({
      date: dayToDate(d),
      uptime: row && row.total > 0 ? Math.round((row.ups / row.total) * 1000) / 10 : null,
    })
  }
  return out
}

/**
 * Daily series for many monitors in a single query -- what the status page needs.
 * Reads days * monitors rows (90 * 20 = 1800) rather than every log in the window.
 */
export async function dailySeriesBulk(
  db: Db,
  monitorIds: string[],
  days: number,
  now: number,
): Promise<Map<string, DailyUptime[]>> {
  const today = dayOf(now)
  const fromDay = today - (days - 1)
  const out = new Map<string, DailyUptime[]>()
  if (monitorIds.length === 0) return out

  const rows = await db.select({
    monitorId: dailyStats.monitorId,
    day: dailyStats.day,
    total: dailyStats.total,
    ups: dailyStats.ups,
  })
    .from(dailyStats)
    .where(and(inArray(dailyStats.monitorId, monitorIds), gte(dailyStats.day, fromDay)))

  const grouped = new Map<string, { day: number; total: number; ups: number }[]>()
  for (const row of rows) {
    const list = grouped.get(row.monitorId) ?? []
    list.push(row)
    grouped.set(row.monitorId, list)
  }

  for (const id of monitorIds) {
    out.set(id, fillDays(grouped.get(id) ?? [], fromDay, today))
  }
  return out
}

/** Uptime totals for many monitors in a single query -- what the dashboard needs. */
export async function uptimeBulk(
  db: Db,
  monitorIds: string[],
  days: number,
  now: number,
): Promise<Map<string, UptimeTotals>> {
  const out = new Map<string, UptimeTotals>()
  if (monitorIds.length === 0) return out

  const rows = await db.select({
    monitorId: dailyStats.monitorId,
    total: sql<number>`COALESCE(SUM(total), 0)`,
    ups: sql<number>`COALESCE(SUM(ups), 0)`,
  })
    .from(dailyStats)
    .where(and(inArray(dailyStats.monitorId, monitorIds), gte(dailyStats.day, dayOf(now) - (days - 1))))
    .groupBy(dailyStats.monitorId)

  for (const row of rows) {
    out.set(row.monitorId, toUptime(Number(row.total), Number(row.ups)))
  }
  for (const id of monitorIds) {
    if (!out.has(id)) out.set(id, toUptime(0, 0))
  }
  return out
}

/** Total checks ever recorded, from the rollup rather than COUNT(*) over raw logs. */
export async function checkCount(db: Db, monitorId: string): Promise<number> {
  const [row] = await db.select({ total: sql<number>`COALESCE(SUM(total), 0)` })
    .from(dailyStats)
    .where(eq(dailyStats.monitorId, monitorId))
  return Number(row?.total ?? 0)
}

export async function avgResponseMs(db: Db, monitorId: string, sinceTs: number): Promise<number | null> {
  const [row] = await db.select({ avg: sql<number | null>`AVG(response_time_ms)` })
    .from(statusLogs)
    .where(and(eq(statusLogs.monitorId, monitorId), gte(statusLogs.checkedAt, sinceTs)))
  return row?.avg == null ? null : Math.round(Number(row.avg))
}

/**
 * Folds one check into its day bucket. Costs a single row written (daily_stats is
 * WITHOUT ROWID, so there is no separate index entry to maintain).
 */
export async function recordCheck(
  db: Db,
  monitorId: string,
  checkedAt: number,
  status: 'up' | 'down' | 'pending',
  responseTimeMs: number | null,
): Promise<void> {
  const isUp = status === 'up' ? 1 : 0
  const rt = responseTimeMs ?? 0
  const hasRt = responseTimeMs == null ? 0 : 1

  await db.insert(dailyStats)
    .values({
      monitorId,
      day: dayOf(checkedAt),
      total: 1,
      ups: isUp,
      rtSum: rt,
      rtCount: hasRt,
    })
    .onConflictDoUpdate({
      target: [dailyStats.monitorId, dailyStats.day],
      set: {
        total: sql`total + 1`,
        ups: sql`ups + ${isUp}`,
        rtSum: sql`rt_sum + ${rt}`,
        rtCount: sql`rt_count + ${hasRt}`,
      },
    })
}

export async function pruneDailyStats(db: Db, beforeDay: number): Promise<void> {
  await db.delete(dailyStats).where(lt(dailyStats.day, beforeDay))
}
