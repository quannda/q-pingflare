import { Hono } from 'hono'
import { getDb } from '../db'
import { settings } from '../db/schema'
import { requireAuth } from '../middleware/auth'
import { rebuildDailyStats } from '../db/migrate'
import { cacheKeys, invalidate } from '../cache'
import type { Env } from '../index'

const app = new Hono<{ Bindings: Env }>()

app.use('*', requireAuth)

app.get('/', async (c) => {
  const db = getDb(c.env.DB)
  const rows = await db.select().from(settings)
  const result: Record<string, string> = {}
  for (const row of rows) result[row.key] = row.value
  return c.json(result)
})

app.put('/', async (c) => {
  const body = await c.req.json<Record<string, string>>()
  const db = getDb(c.env.DB)
  for (const [key, value] of Object.entries(body)) {
    await db.insert(settings)
      .values({ key, value: String(value) })
      .onConflictDoUpdate({ target: settings.key, set: { value: String(value) } })
  }
  const rows = await db.select().from(settings)
  const result: Record<string, string> = {}
  for (const row of rows) result[row.key] = row.value

  // cache_ttl and the retention windows all feed cached payloads.
  await invalidate(c.env, cacheKeys.overview())

  return c.json(result)
})

/**
 * Recomputes daily_stats from the raw status_logs. Needed once after upgrading a
 * database that predates the rollup if the automatic backfill did not complete,
 * and after restoring a backup. Costs one full scan of status_logs.
 */
app.post('/rebuild-stats', async (c) => {
  await rebuildDailyStats(c.env.DB)
  await invalidate(c.env, cacheKeys.overview())
  return c.json({ ok: true })
})

export default app
