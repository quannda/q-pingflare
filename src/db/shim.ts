import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'

class ShimStatement {
  constructor(
    private readonly db: Database.Database,
    private readonly sql: string,
    private readonly values: unknown[] = [],
  ) {}

  private cachedStmt?: Database.Statement

  /**
   * Memoised. This used to re-prepare on every access, which silently broke
   * raw(): the `raw(true)` flag was set on a throwaway statement and the
   * subsequent all() ran on a fresh one that still returned objects. Drizzle maps
   * those rows positionally, so every read came back empty.
   */
  private get stmt(): Database.Statement {
    return (this.cachedStmt ??= this.db.prepare(this.sql))
  }

  bind(...args: unknown[]): ShimStatement {
    return new ShimStatement(this.db, this.sql, args)
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const result = (
      this.values.length ? this.stmt.get(...this.values) : this.stmt.get()
    ) as T | undefined
    if (result == null) return null
    if (colName !== undefined && typeof result === 'object') {
      return ((result as Record<string, unknown>)[colName] as T) ?? null
    }
    return result
  }

  async run(): Promise<{ success: boolean; meta: Record<string, unknown> }> {
    const info = this.values.length
      ? this.stmt.run(...this.values)
      : this.stmt.run()
    return {
      success: true,
      meta: {
        changes: info.changes,
        last_row_id: Number(info.lastInsertRowid),
        duration: 0,
        rows_read: 0,
        rows_written: info.changes,
        size_after: 0,
        changed_db: info.changes > 0,
      },
    }
  }

  async all<T = Record<string, unknown>>(): Promise<{
    results: T[]
    success: boolean
    meta: Record<string, unknown>
  }> {
    const results = (
      this.values.length ? this.stmt.all(...this.values) : this.stmt.all()
    ) as T[]
    return { results, success: true, meta: {} }
  }

  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const stmt = this.stmt
    stmt.raw(true)
    try {
      const rows = (
        this.values.length ? stmt.all(...this.values) : stmt.all()
      ) as T[]
      if (options?.columnNames) {
        const cols = stmt.columns().map((c) => c.name)
        return [cols as unknown as T, ...rows]
      }
      return rows
    } finally {
      stmt.raw(false)
    }
  }

  _execSync(): void {
    this.values.length ? this.stmt.run(...this.values) : this.stmt.run()
  }
}

export class D1Shim {
  constructor(private readonly db: Database.Database) {}

  prepare(sql: string): ShimStatement {
    return new ShimStatement(this.db, sql)
  }

  async batch(stmts: ShimStatement[]): Promise<{ success: boolean }[]> {
    const results: { success: boolean }[] = []
    const runAll = this.db.transaction(() => {
      for (const stmt of stmts) {
        stmt._execSync()
        results.push({ success: true })
      }
    })
    runAll()
    return results
  }

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    this.db.exec(sql)
    return { count: 0, duration: 0 }
  }

  async dump(): Promise<ArrayBuffer> {
    throw new Error('dump() is not supported in SQLite mode')
  }
}

export function openSqlite(dbPath?: string): {
  shim: D1Shim
  raw: Database.Database
} {
  const p = dbPath ?? path.join(process.cwd(), 'data', 'pingflare.db')
  fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true })
  const raw = new Database(p)
  raw.pragma('journal_mode = WAL')
  raw.pragma('foreign_keys = ON')
  return { shim: new D1Shim(raw), raw }
}
