"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc4) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc4 = __getOwnPropDesc(from, key)) || desc4.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/server.ts
var import_hono12 = require("hono");
var import_cors = require("hono/cors");
var import_node_server = require("@hono/node-server");
var import_serve_static = require("@hono/node-server/serve-static");
var import_node_cron = require("node-cron");
var import_node_path2 = __toESM(require("path"));

// src/db/shim.ts
var import_better_sqlite3 = __toESM(require("better-sqlite3"));
var import_node_path = __toESM(require("path"));
var import_node_fs = __toESM(require("fs"));
var ShimStatement = class _ShimStatement {
  constructor(db, sql3, values = []) {
    this.db = db;
    this.sql = sql3;
    this.values = values;
  }
  db;
  sql;
  values;
  cachedStmt;
  /**
   * Memoised. This used to re-prepare on every access, which silently broke
   * raw(): the `raw(true)` flag was set on a throwaway statement and the
   * subsequent all() ran on a fresh one that still returned objects. Drizzle maps
   * those rows positionally, so every read came back empty.
   */
  get stmt() {
    return this.cachedStmt ??= this.db.prepare(this.sql);
  }
  bind(...args) {
    return new _ShimStatement(this.db, this.sql, args);
  }
  async first(colName) {
    const result = this.values.length ? this.stmt.get(...this.values) : this.stmt.get();
    if (result == null) return null;
    if (colName !== void 0 && typeof result === "object") {
      return result[colName] ?? null;
    }
    return result;
  }
  async run() {
    const info = this.values.length ? this.stmt.run(...this.values) : this.stmt.run();
    return {
      success: true,
      meta: {
        changes: info.changes,
        last_row_id: Number(info.lastInsertRowid),
        duration: 0,
        rows_read: 0,
        rows_written: info.changes,
        size_after: 0,
        changed_db: info.changes > 0
      }
    };
  }
  async all() {
    const results = this.values.length ? this.stmt.all(...this.values) : this.stmt.all();
    return { results, success: true, meta: {} };
  }
  async raw(options) {
    const stmt = this.stmt;
    stmt.raw(true);
    try {
      const rows = this.values.length ? stmt.all(...this.values) : stmt.all();
      if (options?.columnNames) {
        const cols = stmt.columns().map((c) => c.name);
        return [cols, ...rows];
      }
      return rows;
    } finally {
      stmt.raw(false);
    }
  }
  _execSync() {
    this.values.length ? this.stmt.run(...this.values) : this.stmt.run();
  }
};
var D1Shim = class {
  constructor(db) {
    this.db = db;
  }
  db;
  prepare(sql3) {
    return new ShimStatement(this.db, sql3);
  }
  async batch(stmts) {
    const results = [];
    const runAll = this.db.transaction(() => {
      for (const stmt of stmts) {
        stmt._execSync();
        results.push({ success: true });
      }
    });
    runAll();
    return results;
  }
  async exec(sql3) {
    this.db.exec(sql3);
    return { count: 0, duration: 0 };
  }
  async dump() {
    throw new Error("dump() is not supported in SQLite mode");
  }
};
function openSqlite(dbPath) {
  const p = dbPath ?? import_node_path.default.join(process.cwd(), "data", "pingflare.db");
  import_node_fs.default.mkdirSync(import_node_path.default.dirname(import_node_path.default.resolve(p)), { recursive: true });
  const raw = new import_better_sqlite3.default(p);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  return { shim: new D1Shim(raw), raw };
}

// src/db/migrate.ts
var SCHEMA_VERSION = 2;
var migrated = false;
var SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS monitors (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  type text NOT NULL,
  tags text DEFAULT '[]' NOT NULL,
  interval integer DEFAULT 60 NOT NULL,
  active integer DEFAULT true NOT NULL,
  last_checked_at integer,
  last_status text DEFAULT 'pending' NOT NULL,
  reminder_interval_hours integer,
  callbacks_enabled integer DEFAULT false NOT NULL,
  tolerance_failures integer DEFAULT 1 NOT NULL,
  url text,
  method text DEFAULT 'GET' NOT NULL,
  body text,
  headers text DEFAULT '{}' NOT NULL,
  expected_status integer DEFAULT 200 NOT NULL,
  follow_redirects integer DEFAULT true NOT NULL,
  timeout integer DEFAULT 30 NOT NULL,
  ip_version text DEFAULT 'auto' NOT NULL,
  auth_type text DEFAULT 'none' NOT NULL,
  auth_username text,
  auth_password text,
  auth_token text,
  heartbeat_interval integer,
  heartbeat_grace integer DEFAULT 30 NOT NULL,
  tolerance_missed integer DEFAULT 1 NOT NULL,
  surge_protection_limit integer,
  created_at integer DEFAULT (unixepoch()) NOT NULL,
  updated_at integer DEFAULT (unixepoch()) NOT NULL
);

CREATE TABLE IF NOT EXISTS status_logs (
  id text PRIMARY KEY NOT NULL,
  monitor_id text NOT NULL,
  status text NOT NULL,
  message text,
  response_time_ms integer,
  checked_at integer NOT NULL,
  FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE IF NOT EXISTS incidents (
  id text PRIMARY KEY NOT NULL,
  monitor_id text NOT NULL,
  started_at integer NOT NULL,
  resolved_at integer,
  duration_seconds integer,
  FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE IF NOT EXISTS notification_channels (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  type text NOT NULL,
  config text DEFAULT '{}' NOT NULL,
  active integer DEFAULT true NOT NULL,
  is_default integer DEFAULT false NOT NULL,
  created_at integer DEFAULT (unixepoch()) NOT NULL
);

CREATE TABLE IF NOT EXISTS monitor_notifications (
  monitor_id text NOT NULL,
  channel_id text NOT NULL,
  PRIMARY KEY(monitor_id, channel_id),
  FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (channel_id) REFERENCES notification_channels(id) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE IF NOT EXISTS heartbeat_tokens (
  monitor_id text PRIMARY KEY NOT NULL,
  token text NOT NULL,
  last_ping_at integer,
  FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON UPDATE no action ON DELETE cascade
);

CREATE UNIQUE INDEX IF NOT EXISTS heartbeat_tokens_token_unique ON heartbeat_tokens (token);

CREATE TABLE IF NOT EXISTS alert_state (
  monitor_id text PRIMARY KEY NOT NULL,
  consecutive_failures integer DEFAULT 0 NOT NULL,
  consecutive_missed integer DEFAULT 0 NOT NULL,
  alert_sent_at integer,
  consecutive_alerts integer DEFAULT 0 NOT NULL,
  last_reminder_at integer,
  surge_paused_until integer,
  FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY NOT NULL,
  value text NOT NULL
);

INSERT OR IGNORE INTO settings (key, value) VALUES ('retention_days', '90');

CREATE TABLE IF NOT EXISTS status_pages (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  slug text NOT NULL,
  description text,
  password_hash text,
  show_all_monitors integer DEFAULT false NOT NULL,
  created_at integer DEFAULT (unixepoch()) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS status_pages_slug_unique ON status_pages (slug);

CREATE TABLE IF NOT EXISTS status_page_monitors (
  page_id text NOT NULL,
  monitor_id text NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  PRIMARY KEY(page_id, monitor_id),
  FOREIGN KEY (page_id) REFERENCES status_pages(id) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE IF NOT EXISTS incident_reports (
  id text PRIMARY KEY NOT NULL,
  title text NOT NULL,
  status text NOT NULL,
  started_at integer DEFAULT (unixepoch()) NOT NULL,
  resolved_at integer
);

CREATE TABLE IF NOT EXISTS incident_updates (
  id text PRIMARY KEY NOT NULL,
  incident_id text NOT NULL,
  message text NOT NULL,
  status text NOT NULL,
  created_at integer DEFAULT (unixepoch()) NOT NULL,
  FOREIGN KEY (incident_id) REFERENCES incident_reports(id) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE IF NOT EXISTS incident_monitors (
  incident_id text NOT NULL,
  monitor_id text NOT NULL,
  PRIMARY KEY(incident_id, monitor_id),
  FOREIGN KEY (incident_id) REFERENCES incident_reports(id) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE IF NOT EXISTS daily_stats (
  monitor_id text NOT NULL,
  day integer NOT NULL,
  total integer DEFAULT 0 NOT NULL,
  ups integer DEFAULT 0 NOT NULL,
  rt_sum integer DEFAULT 0 NOT NULL,
  rt_count integer DEFAULT 0 NOT NULL,
  PRIMARY KEY(monitor_id, day),
  FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON UPDATE no action ON DELETE cascade
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_status_logs_monitor_checked ON status_logs (monitor_id, checked_at);

CREATE INDEX IF NOT EXISTS idx_incidents_monitor_started ON incidents (monitor_id, started_at);

CREATE INDEX IF NOT EXISTS idx_incident_monitors_monitor ON incident_monitors (monitor_id);

INSERT OR IGNORE INTO settings (key, value) VALUES ('stats_retention_days', '400');

INSERT OR IGNORE INTO settings (key, value) VALUES ('cache_ttl', '900');
`;
async function rebuildDailyStats(d1) {
  await d1.prepare(`
    INSERT INTO daily_stats (monitor_id, day, total, ups, rt_sum, rt_count)
    SELECT
      monitor_id,
      checked_at / 86400,
      COUNT(*),
      SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END),
      COALESCE(SUM(response_time_ms), 0),
      COUNT(response_time_ms)
    FROM status_logs
    GROUP BY monitor_id, checked_at / 86400
    ON CONFLICT (monitor_id, day) DO UPDATE SET
      total = excluded.total,
      ups = excluded.ups,
      rt_sum = excluded.rt_sum,
      rt_count = excluded.rt_count
  `).run();
}
async function ensureSchema(d1) {
  if (migrated) return;
  try {
    const row = await d1.prepare(`SELECT value FROM settings WHERE key = 'schema_version'`).first();
    if (row && Number(row.value) >= SCHEMA_VERSION) {
      migrated = true;
      return;
    }
  } catch {
  }
  const statements = SCHEMA_SQL.split(";").map((s2) => s2.trim()).filter((s2) => s2.length > 0);
  await d1.batch(statements.map((s2) => d1.prepare(s2)));
  const alterStatements = [
    `ALTER TABLE status_pages ADD COLUMN show_all_monitors integer DEFAULT false NOT NULL`,
    `ALTER TABLE notification_channels ADD COLUMN is_default integer DEFAULT false NOT NULL`,
    `ALTER TABLE monitors ADD COLUMN ssl_check_enabled integer DEFAULT false NOT NULL`,
    `ALTER TABLE monitors ADD COLUMN ssl_status text DEFAULT 'unknown' NOT NULL`,
    `ALTER TABLE monitors ADD COLUMN cache_booster integer DEFAULT false NOT NULL`,
    `ALTER TABLE status_logs ADD COLUMN colo text`,
    `ALTER TABLE status_logs ADD COLUMN country_code text`,
    `ALTER TABLE status_logs ADD COLUMN origin_ip text`
  ];
  for (const sql3 of alterStatements) {
    try {
      await d1.prepare(sql3).run();
    } catch {
    }
  }
  await d1.prepare(`INSERT INTO settings (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).bind(String(SCHEMA_VERSION)).run();
  migrated = true;
  try {
    await rebuildDailyStats(d1);
  } catch (err) {
    console.error("[migrate] daily_stats backfill failed, run POST /api/settings/rebuild-stats", err);
  }
}

// src/cron.ts
var import_drizzle_orm4 = require("drizzle-orm");

// src/db/index.ts
var import_d1 = require("drizzle-orm/d1");

// src/db/schema.ts
var schema_exports = {};
__export(schema_exports, {
  alertState: () => alertState,
  dailyStats: () => dailyStats,
  heartbeatTokens: () => heartbeatTokens,
  incidentMonitors: () => incidentMonitors,
  incidentReports: () => incidentReports,
  incidentUpdates: () => incidentUpdates,
  incidents: () => incidents,
  monitorNotifications: () => monitorNotifications,
  monitors: () => monitors,
  notificationChannels: () => notificationChannels,
  settings: () => settings,
  statusLogs: () => statusLogs,
  statusPageMonitors: () => statusPageMonitors,
  statusPages: () => statusPages
});
var import_sqlite_core = require("drizzle-orm/sqlite-core");
var import_drizzle_orm = require("drizzle-orm");
var monitors = (0, import_sqlite_core.sqliteTable)("monitors", {
  id: (0, import_sqlite_core.text)("id").primaryKey(),
  name: (0, import_sqlite_core.text)("name").notNull(),
  type: (0, import_sqlite_core.text)("type").notNull().$type(),
  tags: (0, import_sqlite_core.text)("tags").notNull().default("[]"),
  interval: (0, import_sqlite_core.integer)("interval").notNull().default(60),
  active: (0, import_sqlite_core.integer)("active", { mode: "boolean" }).notNull().default(true),
  lastCheckedAt: (0, import_sqlite_core.integer)("last_checked_at"),
  lastStatus: (0, import_sqlite_core.text)("last_status").notNull().default("pending").$type(),
  reminderIntervalHours: (0, import_sqlite_core.integer)("reminder_interval_hours"),
  toleranceFailures: (0, import_sqlite_core.integer)("tolerance_failures").notNull().default(1),
  url: (0, import_sqlite_core.text)("url"),
  method: (0, import_sqlite_core.text)("method").notNull().default("GET"),
  body: (0, import_sqlite_core.text)("body"),
  headers: (0, import_sqlite_core.text)("headers").notNull().default("{}"),
  expectedStatus: (0, import_sqlite_core.integer)("expected_status").notNull().default(200),
  followRedirects: (0, import_sqlite_core.integer)("follow_redirects", { mode: "boolean" }).notNull().default(true),
  timeout: (0, import_sqlite_core.integer)("timeout").notNull().default(30),
  ipVersion: (0, import_sqlite_core.text)("ip_version").notNull().default("auto").$type(),
  authType: (0, import_sqlite_core.text)("auth_type").notNull().default("none").$type(),
  authUsername: (0, import_sqlite_core.text)("auth_username"),
  authPassword: (0, import_sqlite_core.text)("auth_password"),
  authToken: (0, import_sqlite_core.text)("auth_token"),
  heartbeatInterval: (0, import_sqlite_core.integer)("heartbeat_interval"),
  heartbeatGrace: (0, import_sqlite_core.integer)("heartbeat_grace").notNull().default(30),
  toleranceMissed: (0, import_sqlite_core.integer)("tolerance_missed").notNull().default(1),
  surgeProtectionLimit: (0, import_sqlite_core.integer)("surge_protection_limit"),
  sslCheckEnabled: (0, import_sqlite_core.integer)("ssl_check_enabled", { mode: "boolean" }).notNull().default(false),
  sslStatus: (0, import_sqlite_core.text)("ssl_status").notNull().default("unknown").$type(),
  cacheBooster: (0, import_sqlite_core.integer)("cache_booster", { mode: "boolean" }).notNull().default(false),
  createdAt: (0, import_sqlite_core.integer)("created_at").notNull().default(import_drizzle_orm.sql`(unixepoch())`),
  updatedAt: (0, import_sqlite_core.integer)("updated_at").notNull().default(import_drizzle_orm.sql`(unixepoch())`)
});
var statusLogs = (0, import_sqlite_core.sqliteTable)("status_logs", {
  id: (0, import_sqlite_core.text)("id").primaryKey(),
  monitorId: (0, import_sqlite_core.text)("monitor_id").notNull().references(() => monitors.id, { onDelete: "cascade" }),
  status: (0, import_sqlite_core.text)("status").notNull().$type(),
  message: (0, import_sqlite_core.text)("message"),
  responseTimeMs: (0, import_sqlite_core.integer)("response_time_ms"),
  checkedAt: (0, import_sqlite_core.integer)("checked_at").notNull(),
  colo: (0, import_sqlite_core.text)("colo"),
  countryCode: (0, import_sqlite_core.text)("country_code"),
  originIp: (0, import_sqlite_core.text)("origin_ip")
}, (t) => [
  // Every hot query filters by (monitor_id, checked_at). Without this every read
  // is a full table scan. Deliberately the ONLY secondary index on this table:
  // D1 bills each index entry as a row written, so each extra index costs one
  // extra write per check.
  (0, import_sqlite_core.index)("idx_status_logs_monitor_checked").on(t.monitorId, t.checkedAt)
]);
var dailyStats = (0, import_sqlite_core.sqliteTable)("daily_stats", {
  monitorId: (0, import_sqlite_core.text)("monitor_id").notNull().references(() => monitors.id, { onDelete: "cascade" }),
  day: (0, import_sqlite_core.integer)("day").notNull(),
  total: (0, import_sqlite_core.integer)("total").notNull().default(0),
  ups: (0, import_sqlite_core.integer)("ups").notNull().default(0),
  rtSum: (0, import_sqlite_core.integer)("rt_sum").notNull().default(0),
  rtCount: (0, import_sqlite_core.integer)("rt_count").notNull().default(0)
}, (t) => [(0, import_sqlite_core.primaryKey)({ columns: [t.monitorId, t.day] })]);
var incidents = (0, import_sqlite_core.sqliteTable)("incidents", {
  id: (0, import_sqlite_core.text)("id").primaryKey(),
  monitorId: (0, import_sqlite_core.text)("monitor_id").notNull().references(() => monitors.id, { onDelete: "cascade" }),
  startedAt: (0, import_sqlite_core.integer)("started_at").notNull(),
  resolvedAt: (0, import_sqlite_core.integer)("resolved_at"),
  durationSeconds: (0, import_sqlite_core.integer)("duration_seconds")
}, (t) => [(0, import_sqlite_core.index)("idx_incidents_monitor_started").on(t.monitorId, t.startedAt)]);
var notificationChannels = (0, import_sqlite_core.sqliteTable)("notification_channels", {
  id: (0, import_sqlite_core.text)("id").primaryKey(),
  name: (0, import_sqlite_core.text)("name").notNull(),
  type: (0, import_sqlite_core.text)("type").notNull().$type(),
  config: (0, import_sqlite_core.text)("config").notNull().default("{}"),
  active: (0, import_sqlite_core.integer)("active", { mode: "boolean" }).notNull().default(true),
  isDefault: (0, import_sqlite_core.integer)("is_default", { mode: "boolean" }).notNull().default(false),
  createdAt: (0, import_sqlite_core.integer)("created_at").notNull().default(import_drizzle_orm.sql`(unixepoch())`)
});
var monitorNotifications = (0, import_sqlite_core.sqliteTable)("monitor_notifications", {
  monitorId: (0, import_sqlite_core.text)("monitor_id").notNull().references(() => monitors.id, { onDelete: "cascade" }),
  channelId: (0, import_sqlite_core.text)("channel_id").notNull().references(() => notificationChannels.id, { onDelete: "cascade" })
}, (t) => [(0, import_sqlite_core.primaryKey)({ columns: [t.monitorId, t.channelId] })]);
var heartbeatTokens = (0, import_sqlite_core.sqliteTable)("heartbeat_tokens", {
  monitorId: (0, import_sqlite_core.text)("monitor_id").primaryKey().references(() => monitors.id, { onDelete: "cascade" }),
  token: (0, import_sqlite_core.text)("token").notNull().unique(),
  lastPingAt: (0, import_sqlite_core.integer)("last_ping_at")
});
var alertState = (0, import_sqlite_core.sqliteTable)("alert_state", {
  monitorId: (0, import_sqlite_core.text)("monitor_id").primaryKey().references(() => monitors.id, { onDelete: "cascade" }),
  consecutiveFailures: (0, import_sqlite_core.integer)("consecutive_failures").notNull().default(0),
  consecutiveMissed: (0, import_sqlite_core.integer)("consecutive_missed").notNull().default(0),
  alertSentAt: (0, import_sqlite_core.integer)("alert_sent_at"),
  consecutiveAlerts: (0, import_sqlite_core.integer)("consecutive_alerts").notNull().default(0),
  lastReminderAt: (0, import_sqlite_core.integer)("last_reminder_at"),
  surgePausedUntil: (0, import_sqlite_core.integer)("surge_paused_until")
});
var settings = (0, import_sqlite_core.sqliteTable)("settings", {
  key: (0, import_sqlite_core.text)("key").primaryKey(),
  value: (0, import_sqlite_core.text)("value").notNull()
});
var statusPages = (0, import_sqlite_core.sqliteTable)("status_pages", {
  id: (0, import_sqlite_core.text)("id").primaryKey(),
  name: (0, import_sqlite_core.text)("name").notNull(),
  slug: (0, import_sqlite_core.text)("slug").notNull().unique(),
  description: (0, import_sqlite_core.text)("description"),
  passwordHash: (0, import_sqlite_core.text)("password_hash"),
  showAllMonitors: (0, import_sqlite_core.integer)("show_all_monitors", { mode: "boolean" }).notNull().default(false),
  createdAt: (0, import_sqlite_core.integer)("created_at").notNull().default(import_drizzle_orm.sql`(unixepoch())`)
});
var statusPageMonitors = (0, import_sqlite_core.sqliteTable)("status_page_monitors", {
  pageId: (0, import_sqlite_core.text)("page_id").notNull().references(() => statusPages.id, { onDelete: "cascade" }),
  monitorId: (0, import_sqlite_core.text)("monitor_id").notNull().references(() => monitors.id, { onDelete: "cascade" }),
  sortOrder: (0, import_sqlite_core.integer)("sort_order").notNull().default(0)
}, (t) => [(0, import_sqlite_core.primaryKey)({ columns: [t.pageId, t.monitorId] })]);
var incidentReports = (0, import_sqlite_core.sqliteTable)("incident_reports", {
  id: (0, import_sqlite_core.text)("id").primaryKey(),
  title: (0, import_sqlite_core.text)("title").notNull(),
  status: (0, import_sqlite_core.text)("status").notNull().$type(),
  startedAt: (0, import_sqlite_core.integer)("started_at").notNull().default(import_drizzle_orm.sql`(unixepoch())`),
  resolvedAt: (0, import_sqlite_core.integer)("resolved_at")
});
var incidentUpdates = (0, import_sqlite_core.sqliteTable)("incident_updates", {
  id: (0, import_sqlite_core.text)("id").primaryKey(),
  incidentId: (0, import_sqlite_core.text)("incident_id").notNull().references(() => incidentReports.id, { onDelete: "cascade" }),
  message: (0, import_sqlite_core.text)("message").notNull(),
  status: (0, import_sqlite_core.text)("status").notNull().$type(),
  createdAt: (0, import_sqlite_core.integer)("created_at").notNull().default(import_drizzle_orm.sql`(unixepoch())`)
});
var incidentMonitors = (0, import_sqlite_core.sqliteTable)("incident_monitors", {
  incidentId: (0, import_sqlite_core.text)("incident_id").notNull().references(() => incidentReports.id, { onDelete: "cascade" }),
  monitorId: (0, import_sqlite_core.text)("monitor_id").notNull().references(() => monitors.id, { onDelete: "cascade" })
}, (t) => [
  (0, import_sqlite_core.primaryKey)({ columns: [t.incidentId, t.monitorId] }),
  (0, import_sqlite_core.index)("idx_incident_monitors_monitor").on(t.monitorId)
]);

// src/db/index.ts
function getDb(d1) {
  return (0, import_d1.drizzle)(d1, { schema: schema_exports });
}

// src/services/checker.ts
var import_node_crypto = require("crypto");

// locales/en.json
var en_default = {
  "common.save": "Save",
  "common.saving": "Saving\u2026",
  "common.saved": "Saved",
  "common.cancel": "Cancel",
  "common.edit": "Edit",
  "common.delete": "Delete",
  "common.loading": "Loading\u2026",
  "common.active": "Active",
  "common.disabled": "Disabled",
  "common.disabled_lc": "disabled",
  "common.name": "Name",
  "common.url": "URL",
  "common.none": "None",
  "nav.dashboard": "Dashboard",
  "nav.monitors": "Monitors",
  "nav.statusPages": "Status Pages",
  "nav.incidents": "Incidents",
  "nav.notifications": "Notifications",
  "nav.config": "Config",
  "theme.toLightMode": "Switch to light mode",
  "theme.toDarkMode": "Switch to dark mode",
  "layout.signOut": "Sign out",
  "login.username": "Username",
  "login.password": "Password",
  "login.signIn": "Sign in",
  "login.signingIn": "Signing in\u2026",
  "login.invalidCreds": "Invalid username or password",
  "login.language": "Language",
  "dashboard.heading": "Dashboard",
  "dashboard.subtitle": "Uptime monitoring - updates every 10s",
  "dashboard.allOperational": "All systems operational",
  "dashboard.runChecks": "Run checks",
  "dashboard.running": "Running\u2026",
  "dashboard.addMonitor": "Add monitor",
  "dashboard.lastManualRun": "Last manual run:",
  "dashboard.total": "Total",
  "dashboard.operational": "Operational",
  "dashboard.runningFine": "running fine",
  "dashboard.down": "Down",
  "dashboard.needAttention": "need attention",
  "dashboard.allClear": "all clear",
  "dashboard.pending": "Pending",
  "dashboard.awaitingCheck": "awaiting first check",
  "dashboard.noMonitors": "No monitors yet",
  "dashboard.noMonitorsDesc": "Add your first monitor to start tracking uptime.",
  "dashboard.createMonitor": "Create monitor",
  "dashboard.monitorsWord": "monitors",
  "dashboard.pendingLabelOne": "{n} is pending \u2014 click <strong>{action}</strong> to trigger the first check immediately.",
  "dashboard.pendingLabelMany": "{n} are pending \u2014 click <strong>{action}</strong> to trigger the first check immediately.",
  "monitors.heading": "Monitors",
  "monitors.addMonitor": "Add monitor",
  "monitors.searchPlaceholder": "Search name, URL, tag\u2026",
  "monitors.allTypes": "All types",
  "monitors.allStatuses": "All statuses",
  "monitors.up": "Up",
  "monitors.down": "Down",
  "monitors.pending": "Pending",
  "monitors.http": "HTTP",
  "monitors.heartbeat": "Heartbeat",
  "monitors.noMatch": "No monitors match the current filters.",
  "monitors.edit": "Edit",
  "monitors.delete": "Delete",
  "monitors.configuredOne": "configured",
  "monitors.configuredMany": "configured",
  "newMonitor.back": "\u2190 Monitors",
  "newMonitor.heading": "New monitor",
  "newMonitor.subtitle": "Configure a HTTP check or heartbeat monitor.",
  "editMonitor.back": "\u2190 Back to monitor",
  "editMonitor.heading": "Edit monitor",
  "editMonitor.editNamed": "Edit - {name}",
  "monitor.notFound": "Monitor not found.",
  "monitor.back": "\u2190 Monitors",
  "monitor.checkNow": "Check now",
  "monitor.checking": "Checking\u2026",
  "monitor.edit": "Edit",
  "monitor.uptime30d": "30-day uptime",
  "monitor.avgResponse": "Avg response (24h)",
  "monitor.openIncidents": "Open incidents",
  "monitor.lastCheck": "Last check",
  "monitor.pendingHint": "This monitor has never been checked. The cron runs every minute in production. In dev, click Check now above or run:",
  "monitor.uptime90d": "90-day uptime",
  "monitor.overallUptime": "Overall uptime",
  "monitor.last24h": "Last 24h",
  "monitor.last7d": "Last 7 days",
  "monitor.last30d": "Last 30 days",
  "monitor.last90d": "Last 90 days",
  "monitor.responseTime": "Response time - last 24h",
  "monitor.heartbeatUrl": "Heartbeat URL",
  "monitor.heartbeatUrlDesc": "Send a GET or POST to this URL to record a heartbeat ping.",
  "monitor.copy": "Copy",
  "monitor.copied": "Copied!",
  "monitor.regen": "Regen",
  "monitor.regenConfirm": "Regenerate heartbeat token? The old URL will stop working.",
  "monitor.incidents": "Incidents",
  "monitor.noIncidents": "No incidents - everything has been running smoothly.",
  "monitor.resolved": "Resolved",
  "monitor.ongoing": "Ongoing",
  "monitor.recentChecks": "Recent checks",
  "monitor.colStatus": "Status",
  "monitor.colTime": "Time",
  "monitor.colResponse": "Response",
  "monitor.colMessage": "Message",
  "monitor.noLogs": "No check logs yet.",
  "monitor.noLogsPending": 'Click "Check now" to trigger the first check.',
  "monitor.resetStats": "Reset stats",
  "monitor.resetConfirm": "Reset all statistics for this monitor? This will delete all check logs, incidents and uptime data.",
  "monitor.dangerZone": "Danger Zone",
  "monitor.enable": "Enable",
  "monitor.disable": "Disable",
  "monitor.enableConfirm": "Enable this monitor? It will resume being checked.",
  "monitor.disableConfirm": "Disable this monitor? It will stop being checked.",
  "monitor.deleteMonitor": "Delete monitor",
  "monitor.deleteConfirm": 'Delete "{name}"? This action cannot be undone.',
  "monitor.ongoingFor": "ongoing {duration}",
  "monitor.totalChecks": "Total checks",
  "monitor.ssl": "SSL",
  "monitor.sslOk": "Valid",
  "monitor.sslError": "Invalid",
  "monitor.sslUnknown": "Not checked",
  "monitor.configInterval": "Interval",
  "monitor.configProtocol": "Protocol",
  "monitor.configMethod": "Method",
  "monitor.configTimeout": "Timeout",
  "monitor.configHeaders": "Headers",
  "monitor.configCacheBooster": "Cache Buster",
  "monitor.configSslCheck": "SSL Check",
  "monitor.prevPage": "\u2190 Prev",
  "monitor.nextPage": "Next \u2192",
  "monitorCard.uptime": "30d uptime",
  "monitorCard.interval": "interval",
  "monitorCard.lastCheck": "last check",
  "monitorForm.httpCheck": "HTTP / URL Check",
  "monitorForm.heartbeat": "Heartbeat",
  "monitorForm.name": "Name",
  "monitorForm.tags": "Tags (comma-separated)",
  "monitorForm.interval": "Check interval (seconds, min 60)",
  "monitorForm.sectionRequest": "Request",
  "monitorForm.method": "Method",
  "monitorForm.url": "URL",
  "monitorForm.expectedStatus": "Expected status",
  "monitorForm.timeout": "Timeout (seconds)",
  "monitorForm.ipVersion": "IP version",
  "monitorForm.ipAuto": "Auto",
  "monitorForm.followRedirects": "Follow redirects",
  "monitorForm.authentication": "Authentication",
  "monitorForm.authNone": "None",
  "monitorForm.authBasic": "Basic",
  "monitorForm.authDigest": "Digest",
  "monitorForm.authBearer": "Bearer token",
  "monitorForm.authUsername": "Username",
  "monitorForm.authPassword": "Password",
  "monitorForm.bearerToken": "Bearer token",
  "monitorForm.headers": "Request headers (one per line: Key: Value)",
  "monitorForm.requestBody": "Request body (JSON)",
  "monitorForm.sectionHeartbeat": "Heartbeat settings",
  "monitorForm.expectedEvery": "Expected every (seconds)",
  "monitorForm.gracePeriod": "Grace period (seconds)",
  "monitorForm.tolerateMissed": "Tolerate missed heartbeats",
  "monitorForm.surgeProtection": "Surge protection (pause after N alerts)",
  "monitorForm.sslCheck": "Verify SSL certificate",
  "monitorForm.cacheBuster": "Cache Buster (append random param to URL)",
  "monitorForm.sectionAlerts": "Alert options",
  "monitorForm.tolerateFailures": "Tolerate failures before alert",
  "monitorForm.reminder": "Reminder every (hours, empty = disabled)",
  "monitorForm.sectionNotifications": "Notifications",
  "monitorForm.noChannels": "No notification channels configured.",
  "monitorForm.addOne": "Add one",
  "monitorForm.active": "Active",
  "monitorForm.saving": "Saving\u2026",
  "monitorForm.saveChanges": "Save changes",
  "monitorForm.createMonitor": "Create monitor",
  "monitorForm.cancel": "Cancel",
  "monitorForm.disabled": "disabled",
  "incidents.heading": "Incidents",
  "incidents.subtitle": "Track and communicate service incidents publicly",
  "incidents.newIncident": "New incident",
  "incidents.formTitle": "New incident",
  "incidents.labelTitle": "Title",
  "incidents.labelStatus": "Initial status",
  "incidents.labelMessage": "Initial message",
  "incidents.placeholderMessage": "We are investigating increased error rates\u2026",
  "incidents.affectedMonitors": "Affected monitors (optional)",
  "incidents.noMonitors": "No monitors configured.",
  "incidents.creating": "Creating\u2026",
  "incidents.createIncident": "Create incident",
  "incidents.cancel": "Cancel",
  "incidents.updateTitle": "Add update",
  "incidents.labelNewStatus": "New status",
  "incidents.labelUpdateMsg": "Message",
  "incidents.placeholderUpdate": "The issue has been identified\u2026",
  "incidents.posting": "Posting\u2026",
  "incidents.postUpdate": "Post update",
  "incidents.loading": "Loading\u2026",
  "incidents.empty": "No incidents",
  "incidents.emptyDesc": "Create an incident to communicate outages to your users.",
  "incidents.createFirst": "Create your first incident",
  "incidents.started": "Started",
  "incidents.affects": "Affects:",
  "incidents.active": "\u25CF active",
  "incidents.addUpdate": "Add update",
  "incidentStatus.investigating": "Investigating",
  "incidentStatus.identified": "Identified",
  "incidentStatus.monitoring": "Monitoring",
  "incidentStatus.resolved": "Resolved",
  "notifications.heading": "Notifications",
  "notifications.subtitle": "Configure where alerts are sent when monitors change status.",
  "notifications.addChannel": "Add channel",
  "notifications.newChannel": "New channel",
  "notifications.editChannel": "Edit - {name}",
  "notifications.empty": "No notification channels",
  "notifications.emptyDesc": "Add a channel to receive alerts when monitors go down.",
  "notifications.addFirst": "Add your first channel",
  "notifications.active": "Active",
  "notifications.disabled": "Disabled",
  "notifications.edit": "Edit",
  "notifications.delete": "Delete",
  "notificationForm.name": "Name",
  "notificationForm.type": "Type",
  "notificationForm.active": "Active",
  "notificationForm.isDefault": "Default (auto-selected when creating new monitors)",
  "notificationForm.applyToAll": "Apply to all existing monitors when saving",
  "notificationForm.saving": "Saving\u2026",
  "notificationForm.saveChanges": "Save changes",
  "notificationForm.createChannel": "Create channel",
  "notificationForm.sending": "Sending\u2026",
  "notificationForm.sendTest": "Send test",
  "notificationForm.testSuccess": "Test sent successfully!",
  "notificationForm.cancel": "Cancel",
  "notifField.webhookUrl": "Webhook URL",
  "notifField.botToken": "Bot Token",
  "notifField.chatId": "Chat ID",
  "notifField.smtpHost": "SMTP Host",
  "notifField.smtpPort": "SMTP Port",
  "notifField.username": "Username",
  "notifField.password": "Password",
  "notifField.fromAddress": "From address",
  "notifField.toAddresses": "To address(es)",
  "notifField.serverUrl": "Server URL",
  "notifField.topic": "Topic",
  "notifField.tokenOptional": "Token (optional)",
  "notifField.appToken": "App Token",
  "notifField.userKey": "User Key",
  "notifField.url": "URL",
  "notifField.secretOptional": "Secret (optional)",
  "notifField.appriseApiUrl": "Apprise API URL",
  "notifField.notificationUrls": "Notification URLs",
  "notifField.apiTokenOptional": "API Token (optional)",
  "notifField.encryptedPlaceholder": "Leave blank to keep saved value",
  "notifField.encryptedHint": "This field is encrypted. Leave blank to keep the current value.",
  "statusPages.heading": "Status Pages",
  "statusPages.subtitle": "Public pages showing the status of your monitors",
  "statusPages.newPage": "New page",
  "statusPages.newStatusPage": "New status page",
  "statusPages.labelName": "Name",
  "statusPages.labelSlug": "Slug - URL: /s/{slug}",
  "statusPages.labelSlugEdit": "Slug",
  "statusPages.labelDescOpt": "Description (optional)",
  "statusPages.labelPassword": "Password protection (leave blank = public)",
  "statusPages.enablePassword": "Enable password protection",
  "statusPages.placeholderPwd": "Leave blank for public access",
  "statusPages.monitorsToDisplay": "Monitors to display",
  "statusPages.showAllMonitors": "Show all monitors (always includes current and future monitors)",
  "statusPages.noMonitors": "No monitors configured yet.",
  "statusPages.creating": "Saving\u2026",
  "statusPages.createPage": "Create page",
  "statusPages.cancel": "Cancel",
  "statusPages.editPage": "Edit - {name}",
  "statusPages.labelDesc": "Description",
  "statusPages.labelNewPwd": "New password",
  "statusPages.pwdHintKeep": "(leave blank to keep, enter space to remove)",
  "statusPages.pwdHintPublic": "(leave blank = public)",
  "statusPages.saveChanges": "Save changes",
  "statusPages.loading": "Loading\u2026",
  "statusPages.empty": "No status pages yet",
  "statusPages.emptyDesc": "Create a public page to share service status with your users.",
  "statusPages.createFirst": "Create your first page",
  "statusPages.passwordProtected": "password protected",
  "statusPages.copyUrl": "Copy URL",
  "statusPages.edit": "Edit",
  "statusPages.delete": "Delete",
  "config.heading": "Config",
  "config.subtitle": "Global settings for data retention and behaviour.",
  "config.dataRetention": "Data retention",
  "config.dataRetentionDesc": "Status check logs older than this limit are deleted automatically on each cron run. Incidents and uptime summaries are not affected.",
  "config.keepLogsFor": "Keep logs for",
  "config.days": "days",
  "config.allowedRange": "Allowed range: 1\u2013365. Default: 90.",
  "config.saving": "Saving\u2026",
  "config.saved": "Saved",
  "config.save": "Save",
  "config.language": "Language",
  "config.languageDesc": "Choose the display language for the application and public status pages.",
  "config.backup": "Backup & Restore",
  "config.backupDesc": "Export your current configuration to a file and restore it on any Pingflare instance.",
  "config.exportBackup": "Export backup",
  "config.exporting": "Exporting\u2026",
  "config.importBackup": "Import backup",
  "config.importing": "Importing\u2026",
  "config.restoreWarning": "Importing will permanently replace all monitors, notification channels, and status pages.",
  "config.restoreSuccess": "Backup restored successfully",
  "config.restoreConfirm": "This will permanently replace ALL existing monitors, channels, and status pages. Continue?",
  "footer.updateAvailable": "Update available",
  "footer.update": "Update",
  "pub.allOperational": "All systems operational",
  "pub.outage": "Service outage detected",
  "pub.degraded": "Degraded performance",
  "pub.protected": "Protected Status Page",
  "pub.wrongPassword": "Incorrect password. Try again.",
  "pub.enterPassword": "Enter password",
  "pub.checking": "Checking\u2026",
  "pub.accessPage": "Access page",
  "pub.activeIncidents": "Active Incidents",
  "pub.started": "Started",
  "pub.services": "Services",
  "pub.noMonitors": "No monitors on this status page.",
  "pub.90daysAgo": "90 days ago",
  "pub.today": "Today",
  "pub.pastIncidents": "Past Incidents",
  "pub.noIncidents": "No incidents in the last 14 days.",
  "pub.poweredBy": "Powered by",
  "pub.updatesEveryMinute": "Updates every minute",
  "pub.statusOperational": "Operational",
  "pub.statusOutage": "Outage",
  "pub.statusPending": "Pending",
  "pub.uptime": "uptime",
  "pub.noData": "no data",
  "pub.toLightMode": "Switch to light mode",
  "pub.toDarkMode": "Switch to dark mode",
  "pub.exitFullscreen": "Exit fullscreen",
  "pub.enterFullscreen": "Enter fullscreen",
  "pub.lastChecked": "Last checked",
  "pub.avgResponse": "Avg response",
  "pub.lastResponse": "Last response",
  "pub.responseHistory": "Response time (24h)",
  "pub.noResponseData": "No response data",
  "pub.24hAgo": "24h ago",
  "confirm.deleteMonitor": 'Delete "{name}"?',
  "confirm.deleteIncident": 'Delete incident "{name}"?',
  "confirm.deleteChannel": 'Delete channel "{name}"?',
  "confirm.deletePage": 'Delete "{name}"?',
  "chart.notEnoughData": "Not enough data",
  "chart.latestMs": "{ms}ms latest",
  "chart.maxMs": "max {ms}ms",
  "time.never": "Never",
  "time.secondsAgo": "{n}s ago",
  "time.minutesAgo": "{n}m ago",
  "time.hoursAgo": "{n}h ago",
  "time.daysAgo": "{n}d ago",
  "notify.alert": "Alert",
  "notify.recovery": "Recovered",
  "notify.reminder": "Reminder",
  "notify.callback": "Event",
  "notify.down": "is down",
  "notify.up": "is back online",
  "notify.stillDown": "is still down",
  "notify.responseTime": "Response time",
  "notify.incidentStarted": "Incident started",
  "notify.url": "URL",
  "notify.heartbeatReceived": "Heartbeat received",
  "notify.noHeartbeatYet": "No heartbeat received yet",
  "notify.lastHeartbeat": "Last heartbeat {n}s ago",
  "notify.heartbeatOverdue": "Heartbeat overdue by {overdue}s (last seen {lastSeen}s ago)",
  "notify.timeoutAfter": "Timeout after {n}s"
};

// locales/pt-BR.json
var pt_BR_default = {
  "common.save": "Salvar",
  "common.saving": "Salvando\u2026",
  "common.saved": "Salvo",
  "common.cancel": "Cancelar",
  "common.edit": "Editar",
  "common.delete": "Excluir",
  "common.loading": "Carregando\u2026",
  "common.active": "Ativo",
  "common.disabled": "Desativado",
  "common.disabled_lc": "desativado",
  "common.name": "Nome",
  "common.url": "URL",
  "common.none": "Nenhum",
  "nav.dashboard": "Painel",
  "nav.monitors": "Monitores",
  "nav.statusPages": "Status Pages",
  "nav.incidents": "Incidentes",
  "nav.notifications": "Notifica\xE7\xF5es",
  "nav.config": "Configura\xE7\xF5es",
  "theme.toLightMode": "Mudar para modo claro",
  "theme.toDarkMode": "Mudar para modo escuro",
  "layout.signOut": "Sair",
  "login.username": "Usu\xE1rio",
  "login.password": "Senha",
  "login.signIn": "Entrar",
  "login.signingIn": "Entrando\u2026",
  "login.invalidCreds": "Usu\xE1rio ou senha inv\xE1lidos",
  "login.language": "Idioma",
  "dashboard.heading": "Painel",
  "dashboard.subtitle": "Monitoramento de uptime - atualiza a cada 10s",
  "dashboard.allOperational": "Todos os sistemas operacionais",
  "dashboard.runChecks": "Verificar",
  "dashboard.running": "Verificando\u2026",
  "dashboard.addMonitor": "Adicionar monitor",
  "dashboard.lastManualRun": "\xDAltima verifica\xE7\xE3o manual:",
  "dashboard.total": "Total",
  "dashboard.operational": "Operacional",
  "dashboard.runningFine": "funcionando bem",
  "dashboard.down": "Fora do ar",
  "dashboard.needAttention": "precisam de aten\xE7\xE3o",
  "dashboard.allClear": "tudo ok",
  "dashboard.pending": "Pendente",
  "dashboard.awaitingCheck": "aguardando verifica\xE7\xE3o",
  "dashboard.noMonitors": "Nenhum monitor ainda",
  "dashboard.noMonitorsDesc": "Adicione seu primeiro monitor para come\xE7ar a monitorar o uptime.",
  "dashboard.createMonitor": "Criar monitor",
  "dashboard.monitorsWord": "monitores",
  "dashboard.pendingLabelOne": "{n} pendente \u2014 clique em <strong>{action}</strong> para disparar a primeira verifica\xE7\xE3o imediatamente.",
  "dashboard.pendingLabelMany": "{n} pendentes \u2014 clique em <strong>{action}</strong> para disparar a primeira verifica\xE7\xE3o imediatamente.",
  "monitors.heading": "Monitores",
  "monitors.addMonitor": "Adicionar monitor",
  "monitors.searchPlaceholder": "Buscar nome, URL, tag\u2026",
  "monitors.allTypes": "Todos os tipos",
  "monitors.allStatuses": "Todos os status",
  "monitors.up": "Online",
  "monitors.down": "Fora do ar",
  "monitors.pending": "Pendente",
  "monitors.http": "HTTP",
  "monitors.heartbeat": "Heartbeat",
  "monitors.noMatch": "Nenhum monitor corresponde aos filtros atuais.",
  "monitors.edit": "Editar",
  "monitors.delete": "Excluir",
  "monitors.configuredOne": "configurado",
  "monitors.configuredMany": "configurados",
  "newMonitor.back": "\u2190 Monitores",
  "newMonitor.heading": "Novo monitor",
  "newMonitor.subtitle": "Configure uma verifica\xE7\xE3o HTTP ou monitor de heartbeat.",
  "editMonitor.back": "\u2190 Voltar ao monitor",
  "editMonitor.heading": "Editar monitor",
  "editMonitor.editNamed": "Editar - {name}",
  "monitor.notFound": "Monitor n\xE3o encontrado.",
  "monitor.back": "\u2190 Monitores",
  "monitor.checkNow": "Verificar agora",
  "monitor.checking": "Verificando\u2026",
  "monitor.edit": "Editar",
  "monitor.uptime30d": "Uptime 30 dias",
  "monitor.avgResponse": "Resp. m\xE9dia (24h)",
  "monitor.openIncidents": "Incidentes abertos",
  "monitor.lastCheck": "\xDAltima verifica\xE7\xE3o",
  "monitor.pendingHint": "Este monitor nunca foi verificado. O cron roda a cada minuto em produ\xE7\xE3o. No dev, clique em Verificar agora ou execute:",
  "monitor.uptime90d": "Uptime 90 dias",
  "monitor.overallUptime": "Uptime geral",
  "monitor.last24h": "\xDAltimas 24h",
  "monitor.last7d": "\xDAltimos 7 dias",
  "monitor.last30d": "\xDAltimos 30 dias",
  "monitor.last90d": "\xDAltimos 90 dias",
  "monitor.responseTime": "Tempo de resposta - \xFAltimas 24h",
  "monitor.heartbeatUrl": "URL de Heartbeat",
  "monitor.heartbeatUrlDesc": "Envie um GET ou POST para esta URL para registrar um ping de heartbeat.",
  "monitor.copy": "Copiar",
  "monitor.copied": "Copiado!",
  "monitor.regen": "Regenerar",
  "monitor.regenConfirm": "Regenerar token de heartbeat? A URL antiga deixar\xE1 de funcionar.",
  "monitor.incidents": "Incidentes",
  "monitor.noIncidents": "Nenhum incidente - tudo funcionando normalmente.",
  "monitor.resolved": "Resolvido",
  "monitor.ongoing": "Em andamento",
  "monitor.recentChecks": "Verifica\xE7\xF5es recentes",
  "monitor.colStatus": "Status",
  "monitor.colTime": "Hor\xE1rio",
  "monitor.colResponse": "Resposta",
  "monitor.colMessage": "Mensagem",
  "monitor.noLogs": "Nenhum log de verifica\xE7\xE3o ainda.",
  "monitor.noLogsPending": 'Clique em "Verificar agora" para disparar a primeira verifica\xE7\xE3o.',
  "monitor.resetStats": "Resetar estat\xEDsticas",
  "monitor.resetConfirm": "Resetar todas as estat\xEDsticas deste monitor? Isso apagar\xE1 todos os logs, incidentes e dados de uptime.",
  "monitor.dangerZone": "Zona de Perigo",
  "monitor.enable": "Ativar",
  "monitor.disable": "Desativar",
  "monitor.enableConfirm": "Ativar este monitor? Ele voltar\xE1 a ser verificado.",
  "monitor.disableConfirm": "Desativar este monitor? Ele deixar\xE1 de ser verificado.",
  "monitor.deleteMonitor": "Excluir monitor",
  "monitor.deleteConfirm": 'Excluir "{name}"? Esta a\xE7\xE3o n\xE3o pode ser desfeita.',
  "monitor.ongoingFor": "em andamento {duration}",
  "monitor.totalChecks": "Total de verifica\xE7\xF5es",
  "monitor.ssl": "SSL",
  "monitor.sslOk": "V\xE1lido",
  "monitor.sslError": "Inv\xE1lido",
  "monitor.sslUnknown": "N\xE3o verificado",
  "monitor.configInterval": "Intervalo",
  "monitor.configProtocol": "Protocolo",
  "monitor.configMethod": "M\xE9todo",
  "monitor.configTimeout": "Timeout",
  "monitor.configHeaders": "Headers",
  "monitor.configCacheBooster": "Cache Buster",
  "monitor.configSslCheck": "SSL Check",
  "monitor.prevPage": "\u2190 Anterior",
  "monitor.nextPage": "Pr\xF3ximo \u2192",
  "monitorCard.uptime": "30d uptime",
  "monitorCard.interval": "intervalo",
  "monitorCard.lastCheck": "\xFAltima verif.",
  "monitorForm.httpCheck": "HTTP / Verifica\xE7\xE3o de URL",
  "monitorForm.heartbeat": "Heartbeat",
  "monitorForm.name": "Nome",
  "monitorForm.tags": "Tags (separadas por v\xEDrgula)",
  "monitorForm.interval": "Intervalo de verifica\xE7\xE3o (segundos, m\xEDn 60)",
  "monitorForm.sectionRequest": "Requisi\xE7\xE3o",
  "monitorForm.method": "M\xE9todo",
  "monitorForm.url": "URL",
  "monitorForm.expectedStatus": "Status esperado",
  "monitorForm.timeout": "Timeout (segundos)",
  "monitorForm.ipVersion": "Vers\xE3o IP",
  "monitorForm.ipAuto": "Auto",
  "monitorForm.followRedirects": "Seguir redirecionamentos",
  "monitorForm.authentication": "Autentica\xE7\xE3o",
  "monitorForm.authNone": "Nenhuma",
  "monitorForm.authBasic": "B\xE1sica",
  "monitorForm.authDigest": "Digest",
  "monitorForm.authBearer": "Token Bearer",
  "monitorForm.authUsername": "Usu\xE1rio",
  "monitorForm.authPassword": "Senha",
  "monitorForm.bearerToken": "Token Bearer",
  "monitorForm.headers": "Headers da requisi\xE7\xE3o (um por linha: Chave: Valor)",
  "monitorForm.requestBody": "Corpo da requisi\xE7\xE3o (JSON)",
  "monitorForm.sectionHeartbeat": "Configura\xE7\xF5es de heartbeat",
  "monitorForm.expectedEvery": "Esperado a cada (segundos)",
  "monitorForm.gracePeriod": "Per\xEDodo de gra\xE7a (segundos)",
  "monitorForm.tolerateMissed": "Tolerar heartbeats perdidos",
  "monitorForm.surgeProtection": "Prote\xE7\xE3o contra surtos (pausar ap\xF3s N alertas)",
  "monitorForm.sslCheck": "Verificar certificado SSL",
  "monitorForm.cacheBuster": "Cache Buster (adicionar par\xE2metro aleat\xF3rio \xE0 URL)",
  "monitorForm.sectionAlerts": "Op\xE7\xF5es de alerta",
  "monitorForm.tolerateFailures": "Tolerar falhas antes do alerta",
  "monitorForm.reminder": "Lembrete a cada (horas, vazio = desativado)",
  "monitorForm.sectionNotifications": "Notifica\xE7\xF5es",
  "monitorForm.noChannels": "Nenhum canal de notifica\xE7\xE3o configurado.",
  "monitorForm.addOne": "Adicionar um",
  "monitorForm.active": "Ativo",
  "monitorForm.saving": "Salvando\u2026",
  "monitorForm.saveChanges": "Salvar altera\xE7\xF5es",
  "monitorForm.createMonitor": "Criar monitor",
  "monitorForm.cancel": "Cancelar",
  "monitorForm.disabled": "desativado",
  "incidents.heading": "Incidentes",
  "incidents.subtitle": "Acompanhe e comunique incidentes de servi\xE7o publicamente",
  "incidents.newIncident": "Novo incidente",
  "incidents.formTitle": "Novo incidente",
  "incidents.labelTitle": "T\xEDtulo",
  "incidents.labelStatus": "Status inicial",
  "incidents.labelMessage": "Mensagem inicial",
  "incidents.placeholderMessage": "Estamos investigando aumento nas taxas de erro\u2026",
  "incidents.affectedMonitors": "Monitores afetados (opcional)",
  "incidents.noMonitors": "Nenhum monitor configurado.",
  "incidents.creating": "Criando\u2026",
  "incidents.createIncident": "Criar incidente",
  "incidents.cancel": "Cancelar",
  "incidents.updateTitle": "Adicionar atualiza\xE7\xE3o",
  "incidents.labelNewStatus": "Novo status",
  "incidents.labelUpdateMsg": "Mensagem",
  "incidents.placeholderUpdate": "O problema foi identificado\u2026",
  "incidents.posting": "Publicando\u2026",
  "incidents.postUpdate": "Publicar atualiza\xE7\xE3o",
  "incidents.loading": "Carregando\u2026",
  "incidents.empty": "Nenhum incidente",
  "incidents.emptyDesc": "Crie um incidente para comunicar falhas aos seus usu\xE1rios.",
  "incidents.createFirst": "Criar seu primeiro incidente",
  "incidents.started": "Iniciado",
  "incidents.affects": "Afeta:",
  "incidents.active": "\u25CF ativo",
  "incidents.addUpdate": "Adicionar atualiza\xE7\xE3o",
  "incidentStatus.investigating": "Investigando",
  "incidentStatus.identified": "Identificado",
  "incidentStatus.monitoring": "Monitorando",
  "incidentStatus.resolved": "Resolvido",
  "notifications.heading": "Notifica\xE7\xF5es",
  "notifications.subtitle": "Configure para onde os alertas s\xE3o enviados quando os monitores mudam de status.",
  "notifications.addChannel": "Adicionar canal",
  "notifications.newChannel": "Novo canal",
  "notifications.editChannel": "Editar - {name}",
  "notifications.empty": "Nenhum canal de notifica\xE7\xE3o",
  "notifications.emptyDesc": "Adicione um canal para receber alertas quando monitores ficarem fora do ar.",
  "notifications.addFirst": "Adicionar seu primeiro canal",
  "notifications.active": "Ativo",
  "notifications.disabled": "Desativado",
  "notifications.edit": "Editar",
  "notifications.delete": "Excluir",
  "notificationForm.name": "Nome",
  "notificationForm.type": "Tipo",
  "notificationForm.active": "Ativo",
  "notificationForm.isDefault": "Padr\xE3o (selecionado automaticamente ao criar novos monitores)",
  "notificationForm.applyToAll": "Aplicar a todos os monitores existentes ao salvar",
  "notificationForm.saving": "Salvando\u2026",
  "notificationForm.saveChanges": "Salvar altera\xE7\xF5es",
  "notificationForm.createChannel": "Criar canal",
  "notificationForm.sending": "Enviando\u2026",
  "notificationForm.sendTest": "Enviar teste",
  "notificationForm.testSuccess": "Teste enviado com sucesso!",
  "notificationForm.cancel": "Cancelar",
  "notifField.webhookUrl": "URL do Webhook",
  "notifField.botToken": "Token do Bot",
  "notifField.chatId": "ID do Chat",
  "notifField.smtpHost": "Host SMTP",
  "notifField.smtpPort": "Porta SMTP",
  "notifField.username": "Usu\xE1rio",
  "notifField.password": "Senha",
  "notifField.fromAddress": "Endere\xE7o de origem",
  "notifField.toAddresses": "Endere\xE7o(s) de destino",
  "notifField.serverUrl": "URL do servidor",
  "notifField.topic": "T\xF3pico",
  "notifField.tokenOptional": "Token (opcional)",
  "notifField.appToken": "Token do App",
  "notifField.userKey": "Chave do usu\xE1rio",
  "notifField.url": "URL",
  "notifField.secretOptional": "Segredo (opcional)",
  "notifField.appriseApiUrl": "URL da API Apprise",
  "notifField.notificationUrls": "URLs de notifica\xE7\xE3o",
  "notifField.apiTokenOptional": "Token da API (opcional)",
  "notifField.encryptedPlaceholder": "Deixe em branco para manter o valor salvo",
  "notifField.encryptedHint": "Este campo est\xE1 encriptado. Deixe em branco para manter o valor atual.",
  "statusPages.heading": "Status Pages",
  "statusPages.subtitle": "P\xE1ginas p\xFAblicas mostrando o status dos seus monitores",
  "statusPages.newPage": "Nova p\xE1gina",
  "statusPages.newStatusPage": "Nova status page",
  "statusPages.labelName": "Nome",
  "statusPages.labelSlug": "Slug - URL: /s/{slug}",
  "statusPages.labelSlugEdit": "Slug",
  "statusPages.labelDescOpt": "Descri\xE7\xE3o (opcional)",
  "statusPages.labelPassword": "Prote\xE7\xE3o por senha (deixe em branco = p\xFAblico)",
  "statusPages.enablePassword": "Habilitar prote\xE7\xE3o por senha",
  "statusPages.placeholderPwd": "Deixe em branco para acesso p\xFAblico",
  "statusPages.monitorsToDisplay": "Monitores a exibir",
  "statusPages.showAllMonitors": "Exibir todos os monitores (inclui monitores atuais e futuros)",
  "statusPages.noMonitors": "Nenhum monitor configurado ainda.",
  "statusPages.creating": "Salvando\u2026",
  "statusPages.createPage": "Criar p\xE1gina",
  "statusPages.cancel": "Cancelar",
  "statusPages.editPage": "Editar - {name}",
  "statusPages.labelDesc": "Descri\xE7\xE3o",
  "statusPages.labelNewPwd": "Nova senha",
  "statusPages.pwdHintKeep": "(deixe em branco para manter, espa\xE7o para remover)",
  "statusPages.pwdHintPublic": "(deixe em branco = p\xFAblico)",
  "statusPages.saveChanges": "Salvar altera\xE7\xF5es",
  "statusPages.loading": "Carregando\u2026",
  "statusPages.empty": "Nenhuma status page ainda",
  "statusPages.emptyDesc": "Crie uma p\xE1gina p\xFAblica para compartilhar o status dos servi\xE7os com seus usu\xE1rios.",
  "statusPages.createFirst": "Criar sua primeira p\xE1gina",
  "statusPages.passwordProtected": "protegida por senha",
  "statusPages.copyUrl": "Copiar URL",
  "statusPages.edit": "Editar",
  "statusPages.delete": "Excluir",
  "config.heading": "Configura\xE7\xF5es",
  "config.subtitle": "Configura\xE7\xF5es globais de reten\xE7\xE3o de dados e comportamento.",
  "config.dataRetention": "Reten\xE7\xE3o de dados",
  "config.dataRetentionDesc": "Logs de verifica\xE7\xE3o mais antigos que este limite s\xE3o exclu\xEDdos automaticamente a cada execu\xE7\xE3o do cron. Incidentes e resumos de uptime n\xE3o s\xE3o afetados.",
  "config.keepLogsFor": "Manter logs por",
  "config.days": "dias",
  "config.allowedRange": "Intervalo permitido: 1\u2013365. Padr\xE3o: 90.",
  "config.saving": "Salvando\u2026",
  "config.saved": "Salvo",
  "config.save": "Salvar",
  "config.language": "Idioma",
  "config.languageDesc": "Escolha o idioma de exibi\xE7\xE3o do aplicativo e das status pages p\xFAblicas.",
  "config.backup": "Backup e Restaura\xE7\xE3o",
  "config.backupDesc": "Exporte sua configura\xE7\xE3o atual para um arquivo e restaure-a em qualquer inst\xE2ncia do Pingflare.",
  "config.exportBackup": "Exportar backup",
  "config.exporting": "Exportando\u2026",
  "config.importBackup": "Importar backup",
  "config.importing": "Importando\u2026",
  "config.restoreWarning": "Ao importar, todos os monitores, canais de notifica\xE7\xE3o e p\xE1ginas de status ser\xE3o substitu\xEDdos permanentemente.",
  "config.restoreSuccess": "Backup restaurado com sucesso",
  "config.restoreConfirm": "Isso substituir\xE1 permanentemente TODOS os monitores, canais e p\xE1ginas de status existentes. Continuar?",
  "footer.updateAvailable": "Atualiza\xE7\xE3o dispon\xEDvel",
  "footer.update": "Atualizar",
  "pub.allOperational": "Todos os sistemas operacionais",
  "pub.outage": "Falha de servi\xE7o detectada",
  "pub.degraded": "Desempenho degradado",
  "pub.protected": "P\xE1gina de Status Protegida",
  "pub.wrongPassword": "Senha incorreta. Tente novamente.",
  "pub.enterPassword": "Digite a senha",
  "pub.checking": "Verificando\u2026",
  "pub.accessPage": "Acessar p\xE1gina",
  "pub.activeIncidents": "Incidentes Ativos",
  "pub.started": "Iniciado",
  "pub.services": "Servi\xE7os",
  "pub.noMonitors": "Nenhum monitor nesta p\xE1gina de status.",
  "pub.90daysAgo": "H\xE1 90 dias",
  "pub.today": "Hoje",
  "pub.pastIncidents": "Incidentes Anteriores",
  "pub.noIncidents": "Nenhum incidente nos \xFAltimos 14 dias.",
  "pub.poweredBy": "Desenvolvido por",
  "pub.updatesEveryMinute": "Atualiza a cada minuto",
  "pub.statusOperational": "Operacional",
  "pub.statusOutage": "Fora do ar",
  "pub.statusPending": "Pendente",
  "pub.uptime": "uptime",
  "pub.noData": "sem dados",
  "pub.toLightMode": "Mudar para modo claro",
  "pub.toDarkMode": "Mudar para modo escuro",
  "pub.exitFullscreen": "Sair da tela cheia",
  "pub.enterFullscreen": "Entrar em tela cheia",
  "pub.lastChecked": "\xDAltima verifica\xE7\xE3o",
  "pub.avgResponse": "Resp. m\xE9dia",
  "pub.lastResponse": "\xDAltima resposta",
  "pub.responseHistory": "Tempo de resposta (24h)",
  "pub.noResponseData": "Sem dados de resposta",
  "pub.24hAgo": "H\xE1 24h",
  "confirm.deleteMonitor": 'Excluir "{name}"?',
  "confirm.deleteIncident": 'Excluir incidente "{name}"?',
  "confirm.deleteChannel": 'Excluir canal "{name}"?',
  "confirm.deletePage": 'Excluir "{name}"?',
  "chart.notEnoughData": "Dados insuficientes",
  "chart.latestMs": "{ms}ms recente",
  "chart.maxMs": "m\xE1x {ms}ms",
  "time.never": "Nunca",
  "time.secondsAgo": "h\xE1 {n}s",
  "time.minutesAgo": "h\xE1 {n}m",
  "time.hoursAgo": "h\xE1 {n}h",
  "time.daysAgo": "h\xE1 {n}d",
  "notify.alert": "Alerta",
  "notify.recovery": "Recuperado",
  "notify.reminder": "Lembrete",
  "notify.callback": "Evento",
  "notify.down": "est\xE1 fora do ar",
  "notify.up": "voltou ao ar",
  "notify.stillDown": "ainda est\xE1 fora do ar",
  "notify.responseTime": "Tempo de resposta",
  "notify.incidentStarted": "In\xEDcio do incidente",
  "notify.url": "URL",
  "notify.heartbeatReceived": "Heartbeat recebido",
  "notify.noHeartbeatYet": "Nenhum heartbeat recebido ainda",
  "notify.lastHeartbeat": "\xDAltimo heartbeat h\xE1 {n}s",
  "notify.heartbeatOverdue": "Heartbeat atrasado em {overdue}s (\xFAltimo visto h\xE1 {lastSeen}s)",
  "notify.timeoutAfter": "Timeout ap\xF3s {n}s"
};

// src/notifications/messages.ts
var locales = {
  en: en_default,
  "pt-BR": pt_BR_default
};
function sf(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? k));
}
function s(locale, key) {
  return locales[locale]?.[key] ?? locales.en[key] ?? key;
}
function typeLabel(type, locale) {
  return s(locale, `notify.${type}`);
}
function formatMessage(payload, locale) {
  const icon = payload.status === "up" ? "\u2705" : "\u{1F534}";
  const label = s(locale, `notify.${payload.type}`).toUpperCase();
  const statusDesc = payload.type === "reminder" ? s(locale, "notify.stillDown") : payload.status === "up" ? s(locale, "notify.up") : s(locale, "notify.down");
  let text2 = `${icon} [${label}] ${payload.monitor.name} ${statusDesc}`;
  if (payload.message) text2 += `: ${payload.message}`;
  return text2;
}
function msgHeartbeatReceived(locale) {
  return s(locale, "notify.heartbeatReceived");
}
function msgNoHeartbeatYet(locale) {
  return s(locale, "notify.noHeartbeatYet");
}
function msgLastHeartbeat(locale, secondsAgo) {
  return sf(s(locale, "notify.lastHeartbeat"), { n: secondsAgo });
}
function msgHeartbeatOverdue(locale, overdue, lastSeen) {
  return sf(s(locale, "notify.heartbeatOverdue"), { overdue, lastSeen });
}
function msgTimeoutAfter(locale, seconds) {
  return sf(s(locale, "notify.timeoutAfter"), { n: seconds });
}
function metaFields(payload, locale) {
  const fields = [];
  if (payload.monitor.url)
    fields.push({ name: s(locale, "notify.url"), value: payload.monitor.url, inline: true });
  if (payload.responseTimeMs != null)
    fields.push({ name: s(locale, "notify.responseTime"), value: `${payload.responseTimeMs}ms`, inline: true });
  if (payload.incidentStartedAt)
    fields.push({ name: s(locale, "notify.incidentStarted"), value: new Date(payload.incidentStartedAt * 1e3).toUTCString(), inline: false });
  return fields;
}

// src/services/checker.ts
function isSslError(message) {
  const lower = message.toLowerCase();
  return lower.includes("ssl") || lower.includes("certificate") || lower.includes("tls") || lower.includes("cert") || lower.includes("handshake");
}
async function checkHttp(monitor, locale = "en") {
  const start = Date.now();
  try {
    const headers = {};
    if (monitor.headers && monitor.headers !== "{}") {
      Object.assign(headers, JSON.parse(monitor.headers));
    }
    if (monitor.authType === "bearer" && monitor.authToken) {
      headers["Authorization"] = `Bearer ${monitor.authToken}`;
    } else if (monitor.authType === "basic" && monitor.authUsername) {
      const creds = btoa(`${monitor.authUsername}:${monitor.authPassword ?? ""}`);
      headers["Authorization"] = `Basic ${creds}`;
    }
    const method = monitor.method || "GET";
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), (monitor.timeout || 30) * 1e3);
    const init = {
      method,
      headers,
      redirect: monitor.followRedirects ? "follow" : "manual",
      signal: controller.signal
    };
    if (monitor.body && ["POST", "PUT", "PATCH"].includes(method)) {
      init.body = monitor.body;
      if (!headers["Content-Type"] && !headers["content-type"]) {
        headers["Content-Type"] = "application/json";
      }
    }
    let targetUrl = monitor.url;
    if (monitor.cacheBooster) {
      const sep = targetUrl.includes("?") ? "&" : "?";
      targetUrl = `${targetUrl}${sep}pingflare=${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
    }
    const response = await fetch(targetUrl, init);
    clearTimeout(timeoutId);
    const responseTimeMs = Date.now() - start;
    if (monitor.authType === "digest" && response.status === 401) {
      const digestResult = await doDigestAuth(monitor, response, method, responseTimeMs);
      if (digestResult) return digestResult;
    }
    const expectedStatus = monitor.expectedStatus || 200;
    if (response.status === expectedStatus) {
      return { status: "up", statusCode: response.status, responseTimeMs, message: `HTTP ${response.status}` };
    }
    return { status: "down", statusCode: response.status, responseTimeMs, message: `HTTP ${response.status} (expected ${expectedStatus})` };
  } catch (err) {
    const responseTimeMs = Date.now() - start;
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "down", responseTimeMs, message: msgTimeoutAfter(locale, monitor.timeout ?? 30) };
    }
    const msg = String(err);
    return { status: "down", responseTimeMs, message: msg, sslError: isSslError(msg) };
  }
}
async function doDigestAuth(monitor, firstResponse, method, firstRtt) {
  const wwwAuth = firstResponse.headers.get("WWW-Authenticate");
  if (!wwwAuth || !wwwAuth.toLowerCase().startsWith("digest")) return null;
  const parse = (key) => {
    const m = wwwAuth.match(new RegExp(`${key}="([^"]+)"`));
    return m ? m[1] : "";
  };
  const realm = parse("realm");
  const nonce = parse("nonce");
  const qop = wwwAuth.includes("qop=") ? "auth" : "";
  const uri = new URL(monitor.url).pathname || "/";
  const nc = "00000001";
  const cnonce = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const md5 = (s2) => (0, import_node_crypto.createHash)("md5").update(s2).digest("hex");
  const ha1 = md5(`${monitor.authUsername}:${realm}:${monitor.authPassword ?? ""}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = qop ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`);
  let authHeader = `Digest username="${monitor.authUsername}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
  if (qop) authHeader += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  const headers = { Authorization: authHeader };
  if (monitor.headers && monitor.headers !== "{}") Object.assign(headers, JSON.parse(monitor.headers));
  const start2 = Date.now();
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), (monitor.timeout || 30) * 1e3);
    const res2 = await fetch(monitor.url, { method, headers, signal: controller.signal });
    clearTimeout(tid);
    const responseTimeMs = firstRtt + (Date.now() - start2);
    const expected = monitor.expectedStatus || 200;
    if (res2.status === expected) {
      return { status: "up", statusCode: res2.status, responseTimeMs, message: `HTTP ${res2.status} (digest)` };
    }
    return { status: "down", statusCode: res2.status, responseTimeMs, message: `HTTP ${res2.status} (expected ${expected})` };
  } catch (err) {
    return { status: "down", responseTimeMs: firstRtt, message: String(err) };
  }
}

// src/services/heartbeat-checker.ts
function checkHeartbeat(monitor, lastPingAt, now = Math.floor(Date.now() / 1e3), locale = "en") {
  if (lastPingAt === null) {
    return { status: "down", message: msgNoHeartbeatYet(locale), logKey: "notify.noHeartbeatYet" };
  }
  const interval = monitor.heartbeatInterval ?? monitor.interval;
  const grace = monitor.heartbeatGrace ?? 30;
  const deadline = lastPingAt + interval + grace;
  if (now <= deadline) {
    return { status: "up", message: msgLastHeartbeat(locale, now - lastPingAt) };
  }
  const overdue = now - deadline;
  return {
    status: "down",
    message: msgHeartbeatOverdue(locale, overdue, now - lastPingAt)
  };
}

// src/services/alert-manager.ts
var import_drizzle_orm2 = require("drizzle-orm");

// src/notifications/discord.ts
async function sendDiscord(config, payload, locale) {
  const color = payload.status === "up" ? 2278750 : 15680580;
  const icon = payload.status === "up" ? "\u2705" : "\u{1F534}";
  const label = typeLabel(payload.type, locale);
  const embed = {
    title: `${icon} ${label}: ${payload.monitor.name}`,
    description: payload.message || void 0,
    color,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    fields: metaFields(payload, locale)
  };
  await fetch(config.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] })
  });
}

// src/notifications/slack.ts
async function sendSlack(config, payload, locale) {
  await fetch(config.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: formatMessage(payload, locale) })
  });
}

// src/notifications/telegram.ts
async function sendTelegram(config, payload, locale) {
  const icon = payload.status === "up" ? "\u2705" : "\u{1F534}";
  const label = typeLabel(payload.type, locale);
  let text2 = `${icon} <b>${label}: ${payload.monitor.name}</b>`;
  if (payload.message) text2 += `
${payload.message}`;
  if (payload.monitor.url) text2 += `
<code>${payload.monitor.url}</code>`;
  if (payload.responseTimeMs != null) text2 += `
${payload.responseTimeMs}ms`;
  await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: config.chatId, text: text2, parse_mode: "HTML" })
  });
}

// src/shims/cloudflare-sockets.ts
var import_node_net = __toESM(require("net"));
var import_node_tls = __toESM(require("tls"));
function wrapSocket(socket) {
  const readable = new ReadableStream({
    start(controller) {
      socket.on("data", (chunk) => controller.enqueue(new Uint8Array(chunk)));
      socket.on("end", () => controller.close());
      socket.on("error", (err) => controller.error(err));
    },
    cancel() {
      socket.destroy();
    }
  });
  const writable = new WritableStream({
    write(chunk) {
      return new Promise((resolve, reject) => {
        socket.write(chunk, (err) => err ? reject(err) : resolve());
      });
    },
    close() {
      return new Promise((resolve) => socket.end(() => resolve()));
    },
    abort() {
      socket.destroy();
    }
  });
  return {
    readable,
    writable,
    startTls() {
      const tlsSocket = import_node_tls.default.connect({ socket, rejectUnauthorized: false });
      return wrapSocket(tlsSocket);
    },
    close() {
      socket.destroy();
    }
  };
}
function connect(address, options) {
  const implicitTLS = options?.secureTransport === "on";
  const socket = implicitTLS ? import_node_tls.default.connect({
    host: address.hostname,
    port: address.port,
    rejectUnauthorized: false
  }) : import_node_net.default.connect({ host: address.hostname, port: address.port });
  return wrapSocket(socket);
}

// src/notifications/email.ts
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
function encodeHeader(value) {
  if (/[^\x00-\x7f]/.test(value)) return `=?UTF-8?B?${utf8ToBase64(value)}?=`;
  return value;
}
var SmtpConnection = class {
  reader;
  writer;
  decoder = new TextDecoder();
  encoder = new TextEncoder();
  buf = "";
  constructor(socket) {
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }
  async readResponse() {
    while (true) {
      const idx = this.buf.indexOf("\r\n");
      if (idx !== -1) {
        const line = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 2);
        const code = parseInt(line.slice(0, 3), 10);
        if (line[3] !== "-") return code;
        continue;
      }
      const { done, value } = await this.reader.read();
      if (done) throw new Error("SMTP: connection closed unexpectedly");
      this.buf += this.decoder.decode(value, { stream: true });
    }
  }
  async cmd(command, expect) {
    await this.writer.write(this.encoder.encode(command + "\r\n"));
    const code = await this.readResponse();
    if (code !== expect) throw new Error(`SMTP: expected ${expect}, got ${code} (${command.split(" ")[0]})`);
  }
  async sendData(message) {
    await this.writer.write(this.encoder.encode("DATA\r\n"));
    const code = await this.readResponse();
    if (code !== 354) throw new Error(`SMTP: expected 354 for DATA, got ${code}`);
    const stuffed = message.replace(/^\./gm, "..");
    await this.writer.write(this.encoder.encode(stuffed + "\r\n.\r\n"));
    const end = await this.readResponse();
    if (end !== 250) throw new Error(`SMTP: message rejected with ${end}`);
  }
  release() {
    this.reader.releaseLock();
    this.writer.releaseLock();
  }
};
async function sendEmail(config, payload, locale) {
  const { host, port, user, password, from, to } = config;
  const smtpPort = parseInt(port ?? "587", 10);
  const implicitTLS = smtpPort === 465;
  const icon = payload.status === "up" ? "\u2705" : "\u{1F534}";
  const label = typeLabel(payload.type, locale);
  const subject = `${icon} ${label}: ${payload.monitor.name}`;
  const bodyLines = [`<h2>${subject}</h2>`];
  if (payload.message) bodyLines.push(`<p>${payload.message}</p>`);
  for (const field of metaFields(payload, locale)) {
    bodyLines.push(`<p><b>${field.name}:</b> ${field.value}</p>`);
  }
  const recipients = to.split(",").map((s2) => s2.trim()).filter(Boolean);
  const message = [
    `Date: ${(/* @__PURE__ */ new Date()).toUTCString()}`,
    `From: ${from}`,
    `To: ${recipients.join(", ")}`,
    `Subject: ${encodeHeader(subject)}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset=UTF-8`,
    `Content-Transfer-Encoding: 8bit`,
    ``,
    bodyLines.join("\n")
  ].join("\r\n");
  let socket = connect(
    { hostname: host, port: smtpPort },
    { secureTransport: implicitTLS ? "on" : "starttls", allowHalfOpen: false }
  );
  let conn = new SmtpConnection(socket);
  await conn.readResponse();
  await conn.cmd("EHLO pingflare", 250);
  if (!implicitTLS) {
    await conn.cmd("STARTTLS", 220);
    conn.release();
    socket = socket.startTls();
    conn = new SmtpConnection(socket);
    await conn.cmd("EHLO pingflare", 250);
  }
  await conn.cmd("AUTH LOGIN", 334);
  await conn.cmd(utf8ToBase64(user), 334);
  await conn.cmd(utf8ToBase64(password), 235);
  await conn.cmd(`MAIL FROM:<${from}>`, 250);
  for (const rcpt of recipients) {
    await conn.cmd(`RCPT TO:<${rcpt}>`, 250);
  }
  await conn.sendData(message);
  await conn.cmd("QUIT", 221);
  socket.close();
}

// src/notifications/ntfy.ts
async function sendNtfy(config, payload, locale) {
  const priority = payload.status === "down" ? "4" : "2";
  const tag = payload.status === "up" ? "white_check_mark" : "red_circle";
  const headers = {
    "Title": payload.monitor.name,
    "Priority": priority,
    "Tags": tag
  };
  if (config.token) headers["Authorization"] = `Bearer ${config.token}`;
  await fetch(`${config.url}/${config.topic}`, {
    method: "POST",
    headers,
    body: formatMessage(payload, locale)
  });
}

// src/notifications/pushover.ts
async function sendPushover(config, payload, locale) {
  const priority = payload.status === "down" ? "1" : "0";
  await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: config.token,
      user: config.user,
      message: formatMessage(payload, locale),
      priority,
      title: payload.monitor.name
    })
  });
}

// src/notifications/webhook.ts
async function sendWebhook(config, payload) {
  const headers = { "Content-Type": "application/json" };
  if (config.secret) headers["X-Pingflare-Secret"] = config.secret;
  await fetch(config.url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...payload,
      timestamp: Math.floor(Date.now() / 1e3)
    })
  });
}

// src/notifications/apprise.ts
async function sendApprise(config, payload, locale) {
  const headers = { "Content-Type": "application/json" };
  if (config.token) headers["Authorization"] = `Bearer ${config.token}`;
  await fetch(`${config.url}/notify`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      urls: config.urls,
      title: payload.monitor.name,
      body: formatMessage(payload, locale),
      type: payload.status === "up" ? "success" : "failure"
    })
  });
}

// src/notifications/googlechat.ts
async function sendGoogleChat(config, payload, locale) {
  await fetch(config.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: formatMessage(payload, locale) })
  });
}

// src/utils.ts
var SENSITIVE_FIELDS = {
  telegram: ["botToken"],
  email: ["password"],
  ntfy: ["token"],
  pushover: ["user"],
  webhook: ["secret"],
  apprise: ["token"]
};
var ENCRYPTED_PREFIX = "enc:";
async function deriveAesKey(secret) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", hash, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
function isEncryptedValue(value) {
  return typeof value === "string" && value.startsWith(ENCRYPTED_PREFIX);
}
async function encryptField(value, secret) {
  const key = await deriveAesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value));
  const ivB64 = btoa(String.fromCharCode(...iv));
  const ctB64 = btoa(String.fromCharCode(...new Uint8Array(ct)));
  return `${ENCRYPTED_PREFIX}${ivB64}:${ctB64}`;
}
async function decryptField(encrypted, secret) {
  if (!isEncryptedValue(encrypted)) return encrypted;
  const rest = encrypted.slice(ENCRYPTED_PREFIX.length);
  const colonIdx = rest.indexOf(":");
  const iv = Uint8Array.from(atob(rest.slice(0, colonIdx)), (c) => c.charCodeAt(0));
  const ct = Uint8Array.from(atob(rest.slice(colonIdx + 1)), (c) => c.charCodeAt(0));
  const key = await deriveAesKey(secret);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(plain);
}
async function sha256(text2) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text2));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hashPassword(password) {
  const enc = new TextEncoder();
  const salt = Array.from(crypto.getRandomValues(new Uint8Array(16))).map((b) => b.toString(16).padStart(2, "0")).join("");
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: 1e4 },
    key,
    256
  );
  const hash = Array.from(new Uint8Array(bits)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${salt}:${hash}`;
}
async function verifyPassword(password, stored) {
  const colonIdx = stored.indexOf(":");
  if (colonIdx === -1) {
    return await sha256(password) === stored;
  }
  const salt = stored.slice(0, colonIdx);
  const hash = stored.slice(colonIdx + 1);
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: 1e4 },
    key,
    256
  );
  const computed = Array.from(new Uint8Array(bits)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return computed === hash;
}

// src/notifications/index.ts
async function sendNotification(channel, payload, encryptionKey) {
  const config = JSON.parse(channel.config);
  if (encryptionKey) {
    for (const field of SENSITIVE_FIELDS[channel.type] ?? []) {
      if (config[field] && isEncryptedValue(config[field])) {
        config[field] = await decryptField(config[field], encryptionKey);
      }
    }
  }
  const locale = payload.locale ?? "en";
  switch (channel.type) {
    case "discord":
      return sendDiscord(config, payload, locale);
    case "slack":
      return sendSlack(config, payload, locale);
    case "telegram":
      return sendTelegram(config, payload, locale);
    case "email":
      return sendEmail(config, payload, locale);
    case "ntfy":
      return sendNtfy(config, payload, locale);
    case "pushover":
      return sendPushover(config, payload, locale);
    case "webhook":
      return sendWebhook(config, payload);
    case "apprise":
      return sendApprise(config, payload, locale);
    case "googlechat":
      return sendGoogleChat(config, payload, locale);
  }
}

// src/services/alert-manager.ts
async function processAlert(ctx) {
  const { db, monitor, status, message, responseTimeMs, encryptionKey } = ctx;
  const now = Math.floor(Date.now() / 1e3);
  let state = await db.query.alertState.findFirst({
    where: (0, import_drizzle_orm2.eq)(alertState.monitorId, monitor.id)
  });
  if (!state) {
    await db.insert(alertState).values({ monitorId: monitor.id });
    state = {
      monitorId: monitor.id,
      consecutiveFailures: 0,
      consecutiveMissed: 0,
      alertSentAt: null,
      consecutiveAlerts: 0,
      lastReminderAt: null,
      surgePausedUntil: null
    };
  }
  let channelsCache = null;
  const channels = async () => channelsCache ??= await getChannels(db, monitor.id);
  const locale = ctx.locale ?? await getLocale(db);
  const prevStatus = monitor.lastStatus;
  if (status === "down") {
    const newFailures = (monitor.type === "heartbeat" ? state.consecutiveMissed : state.consecutiveFailures) + 1;
    if (monitor.type === "heartbeat") {
      await db.update(alertState).set({ consecutiveMissed: newFailures }).where((0, import_drizzle_orm2.eq)(alertState.monitorId, monitor.id));
    } else {
      await db.update(alertState).set({ consecutiveFailures: newFailures }).where((0, import_drizzle_orm2.eq)(alertState.monitorId, monitor.id));
    }
    const tolerance = monitor.type === "heartbeat" ? monitor.toleranceMissed ?? 1 : monitor.toleranceFailures ?? 1;
    if (newFailures < tolerance) {
      await db.update(monitors).set({ lastCheckedAt: now }).where((0, import_drizzle_orm2.eq)(monitors.id, monitor.id));
      return;
    }
    if (state.surgePausedUntil && now < state.surgePausedUntil) {
      await updateMonitorStatus(db, monitor.id, "down", now);
      return;
    }
    await updateMonitorStatus(db, monitor.id, "down", now);
    if (prevStatus !== "down") {
      await openIncident(db, monitor.id, now);
      const payload = {
        type: "alert",
        monitor: { id: monitor.id, name: monitor.name, type: monitor.type, url: monitor.url },
        status: "down",
        message,
        responseTimeMs,
        locale
      };
      await dispatchToChannels(await channels(), payload, encryptionKey);
      await db.update(alertState).set({ alertSentAt: now, consecutiveAlerts: (state.consecutiveAlerts ?? 0) + 1, lastReminderAt: now }).where((0, import_drizzle_orm2.eq)(alertState.monitorId, monitor.id));
      const limit = monitor.surgeProtectionLimit;
      if (limit && state.consecutiveAlerts + 1 >= limit) {
        const pauseUntil = now + 3600;
        await db.update(alertState).set({ surgePausedUntil: pauseUntil }).where((0, import_drizzle_orm2.eq)(alertState.monitorId, monitor.id));
      }
    } else {
      if (monitor.reminderIntervalHours && state.alertSentAt) {
        const reminderThreshold = (state.lastReminderAt ?? state.alertSentAt) + monitor.reminderIntervalHours * 3600;
        if (now >= reminderThreshold) {
          const incident = await getOpenIncident(db, monitor.id);
          const payload = {
            type: "reminder",
            monitor: { id: monitor.id, name: monitor.name, type: monitor.type, url: monitor.url },
            status: "down",
            message,
            responseTimeMs,
            incidentStartedAt: incident?.startedAt,
            locale
          };
          await dispatchToChannels(await channels(), payload, encryptionKey);
          await db.update(alertState).set({ lastReminderAt: now }).where((0, import_drizzle_orm2.eq)(alertState.monitorId, monitor.id));
        }
      }
    }
  } else {
    const wasDown = prevStatus === "down";
    if (isDirty(state)) {
      await db.update(alertState).set({
        consecutiveFailures: 0,
        consecutiveMissed: 0,
        alertSentAt: null,
        consecutiveAlerts: 0,
        lastReminderAt: null,
        surgePausedUntil: null
      }).where((0, import_drizzle_orm2.eq)(alertState.monitorId, monitor.id));
    }
    const orphanedIncident = !wasDown ? await getOpenIncident(db, monitor.id) : null;
    if (wasDown || orphanedIncident) {
      await closeIncident(db, monitor.id, now);
      const payload = {
        type: "recovery",
        monitor: { id: monitor.id, name: monitor.name, type: monitor.type, url: monitor.url },
        status: "up",
        message,
        responseTimeMs,
        locale
      };
      await dispatchToChannels(await channels(), payload, encryptionKey);
    }
    await updateMonitorStatus(db, monitor.id, "up", now);
  }
}
function isDirty(state) {
  return state.consecutiveFailures !== 0 || state.consecutiveMissed !== 0 || state.alertSentAt !== null || state.consecutiveAlerts !== 0 || state.lastReminderAt !== null || state.surgePausedUntil !== null;
}
async function getChannels(db, monitorId) {
  const rows = await db.select({ channel: notificationChannels }).from(monitorNotifications).innerJoin(notificationChannels, (0, import_drizzle_orm2.eq)(monitorNotifications.channelId, notificationChannels.id)).where((0, import_drizzle_orm2.eq)(monitorNotifications.monitorId, monitorId));
  return rows.filter((r) => r.channel.active).map((r) => r.channel);
}
async function dispatchToChannels(channels, payload, encryptionKey) {
  await Promise.allSettled(channels.map((ch) => sendNotification(ch, payload, encryptionKey)));
}
async function updateMonitorStatus(db, monitorId, status, now) {
  await db.update(monitors).set({ lastStatus: status, lastCheckedAt: now }).where((0, import_drizzle_orm2.eq)(monitors.id, monitorId));
}
async function openIncident(db, monitorId, now) {
  await db.insert(incidents).values({
    id: crypto.randomUUID(),
    monitorId,
    startedAt: now
  });
}
async function getOpenIncident(db, monitorId) {
  return db.query.incidents.findFirst({
    where: (i, { and: and5, eq: eq11, isNull }) => and5(eq11(i.monitorId, monitorId), isNull(i.resolvedAt))
  });
}
async function closeIncident(db, monitorId, now) {
  const incident = await getOpenIncident(db, monitorId);
  if (!incident) return;
  await db.update(incidents).set({ resolvedAt: now, durationSeconds: now - incident.startedAt }).where((0, import_drizzle_orm2.eq)(incidents.id, incident.id));
}
async function getLocale(db) {
  const row = await db.query.settings.findFirst({ where: (0, import_drizzle_orm2.eq)(settings.key, "locale") });
  return row?.value ?? "en";
}

// src/services/stats.ts
var import_drizzle_orm3 = require("drizzle-orm");
var SECONDS_PER_DAY = 86400;
function dayOf(unixSeconds) {
  return Math.floor(unixSeconds / SECONDS_PER_DAY);
}
function dayToDate(day) {
  return new Date(day * SECONDS_PER_DAY * 1e3).toISOString().slice(0, 10);
}
async function loadSettings(db) {
  const rows = await db.select().from(settings);
  const out = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}
function toUptime(total, ups) {
  return { total, ups, uptime: total > 0 ? Math.round(ups / total * 1e4) / 100 : null };
}
async function uptimeFromLogs(db, monitorId, sinceTs) {
  const [row] = await db.select({
    total: import_drizzle_orm3.sql`COUNT(*)`,
    ups: import_drizzle_orm3.sql`COALESCE(SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END), 0)`
  }).from(statusLogs).where((0, import_drizzle_orm3.and)((0, import_drizzle_orm3.eq)(statusLogs.monitorId, monitorId), (0, import_drizzle_orm3.gte)(statusLogs.checkedAt, sinceTs)));
  return toUptime(Number(row?.total ?? 0), Number(row?.ups ?? 0));
}
async function uptimeFromStats(db, monitorId, sinceDay) {
  const [row] = await db.select({
    total: import_drizzle_orm3.sql`COALESCE(SUM(total), 0)`,
    ups: import_drizzle_orm3.sql`COALESCE(SUM(ups), 0)`
  }).from(dailyStats).where((0, import_drizzle_orm3.and)((0, import_drizzle_orm3.eq)(dailyStats.monitorId, monitorId), (0, import_drizzle_orm3.gte)(dailyStats.day, sinceDay)));
  return toUptime(Number(row?.total ?? 0), Number(row?.ups ?? 0));
}
async function uptimeForDays(db, monitorId, days, now) {
  if (days <= 2) return uptimeFromLogs(db, monitorId, now - days * SECONDS_PER_DAY);
  return uptimeFromStats(db, monitorId, dayOf(now) - (days - 1));
}
async function dailySeries(db, monitorId, days, now) {
  const today = dayOf(now);
  const fromDay = today - (days - 1);
  const rows = await db.select({
    day: dailyStats.day,
    total: dailyStats.total,
    ups: dailyStats.ups
  }).from(dailyStats).where((0, import_drizzle_orm3.and)((0, import_drizzle_orm3.eq)(dailyStats.monitorId, monitorId), (0, import_drizzle_orm3.gte)(dailyStats.day, fromDay)));
  return fillDays(rows, fromDay, today);
}
function fillDays(rows, fromDay, today) {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out = [];
  for (let d = fromDay; d <= today; d++) {
    const row = byDay.get(d);
    out.push({
      date: dayToDate(d),
      uptime: row && row.total > 0 ? Math.round(row.ups / row.total * 1e3) / 10 : null
    });
  }
  return out;
}
async function dailySeriesBulk(db, monitorIds, days, now) {
  const today = dayOf(now);
  const fromDay = today - (days - 1);
  const out = /* @__PURE__ */ new Map();
  if (monitorIds.length === 0) return out;
  const rows = await db.select({
    monitorId: dailyStats.monitorId,
    day: dailyStats.day,
    total: dailyStats.total,
    ups: dailyStats.ups
  }).from(dailyStats).where((0, import_drizzle_orm3.and)((0, import_drizzle_orm3.inArray)(dailyStats.monitorId, monitorIds), (0, import_drizzle_orm3.gte)(dailyStats.day, fromDay)));
  const grouped = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const list = grouped.get(row.monitorId) ?? [];
    list.push(row);
    grouped.set(row.monitorId, list);
  }
  for (const id of monitorIds) {
    out.set(id, fillDays(grouped.get(id) ?? [], fromDay, today));
  }
  return out;
}
async function uptimeBulk(db, monitorIds, days, now) {
  const out = /* @__PURE__ */ new Map();
  if (monitorIds.length === 0) return out;
  const rows = await db.select({
    monitorId: dailyStats.monitorId,
    total: import_drizzle_orm3.sql`COALESCE(SUM(total), 0)`,
    ups: import_drizzle_orm3.sql`COALESCE(SUM(ups), 0)`
  }).from(dailyStats).where((0, import_drizzle_orm3.and)((0, import_drizzle_orm3.inArray)(dailyStats.monitorId, monitorIds), (0, import_drizzle_orm3.gte)(dailyStats.day, dayOf(now) - (days - 1)))).groupBy(dailyStats.monitorId);
  for (const row of rows) {
    out.set(row.monitorId, toUptime(Number(row.total), Number(row.ups)));
  }
  for (const id of monitorIds) {
    if (!out.has(id)) out.set(id, toUptime(0, 0));
  }
  return out;
}
async function checkCount(db, monitorId) {
  const [row] = await db.select({ total: import_drizzle_orm3.sql`COALESCE(SUM(total), 0)` }).from(dailyStats).where((0, import_drizzle_orm3.eq)(dailyStats.monitorId, monitorId));
  return Number(row?.total ?? 0);
}
async function avgResponseMs(db, monitorId, sinceTs) {
  const [row] = await db.select({ avg: import_drizzle_orm3.sql`AVG(response_time_ms)` }).from(statusLogs).where((0, import_drizzle_orm3.and)((0, import_drizzle_orm3.eq)(statusLogs.monitorId, monitorId), (0, import_drizzle_orm3.gte)(statusLogs.checkedAt, sinceTs)));
  return row?.avg == null ? null : Math.round(Number(row.avg));
}
async function recordCheck(db, monitorId, checkedAt, status, responseTimeMs) {
  const isUp = status === "up" ? 1 : 0;
  const rt = responseTimeMs ?? 0;
  const hasRt = responseTimeMs == null ? 0 : 1;
  await db.insert(dailyStats).values({
    monitorId,
    day: dayOf(checkedAt),
    total: 1,
    ups: isUp,
    rtSum: rt,
    rtCount: hasRt
  }).onConflictDoUpdate({
    target: [dailyStats.monitorId, dailyStats.day],
    set: {
      total: import_drizzle_orm3.sql`total + 1`,
      ups: import_drizzle_orm3.sql`ups + ${isUp}`,
      rtSum: import_drizzle_orm3.sql`rt_sum + ${rt}`,
      rtCount: import_drizzle_orm3.sql`rt_count + ${hasRt}`
    }
  });
}
async function pruneDailyStats(db, beforeDay) {
  await db.delete(dailyStats).where((0, import_drizzle_orm3.lt)(dailyStats.day, beforeDay));
}

// src/cache.ts
var MIN_TTL = 60;
var DEFAULT_TTL = 900;
function cacheTtl(settings2) {
  const raw = Number(settings2["cache_ttl"]);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TTL;
  return Math.max(MIN_TTL, Math.floor(raw));
}
async function cached(env, key, ttlSeconds, compute) {
  const kv = env.CACHE;
  if (!kv) return compute();
  try {
    const hit = await kv.get(key, "json");
    if (hit !== null) return hit;
  } catch (err) {
    console.error("[cache] read failed", key, err);
  }
  const value = await compute();
  try {
    await kv.put(key, JSON.stringify(value), {
      expirationTtl: Math.max(MIN_TTL, ttlSeconds)
    });
  } catch (err) {
    console.error("[cache] write failed", key, err);
  }
  return value;
}
async function invalidate(env, ...keys) {
  const kv = env.CACHE;
  if (!kv || keys.length === 0) return;
  await Promise.allSettled(keys.map((k) => kv.delete(k).catch(() => {
  })));
}
var cacheKeys = {
  overview: () => "agg:v1:overview",
  monitor: (id) => `agg:v1:monitor:${id}`,
  publicPage: (slug) => `agg:v1:public:${slug}`,
  publicMonitor: (slug, monitorId) => `agg:v1:public:${slug}:${monitorId}`
};

// src/cron.ts
async function getWorkerOrigin() {
  try {
    const res = await fetch("https://1.1.1.1/cdn-cgi/trace", { signal: AbortSignal.timeout(3e3) });
    const text2 = await res.text();
    const colo = text2.match(/^colo=(.+)$/m)?.[1] ?? null;
    const loc = text2.match(/^loc=(.+)$/m)?.[1] ?? null;
    const ip = text2.match(/^ip=(.+)$/m)?.[1] ?? "";
    if (!colo || !loc) return null;
    return { colo, countryCode: loc, originIp: ip };
  } catch {
    return null;
  }
}
function intSetting(all, key, fallback) {
  const n = Number(all[key]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
async function runRetention(db, all, now) {
  const lastRun = Number(all["last_cleanup_at"] ?? 0);
  if (Number.isFinite(lastRun) && now - lastRun < SECONDS_PER_DAY) return;
  await db.insert(settings).values({ key: "last_cleanup_at", value: String(now) }).onConflictDoUpdate({ target: settings.key, set: { value: String(now) } });
  const ids = await db.select({ id: monitors.id }).from(monitors);
  const logCutoff = now - intSetting(all, "retention_days", 90) * SECONDS_PER_DAY;
  for (const { id } of ids) {
    await db.delete(statusLogs).where((0, import_drizzle_orm4.and)((0, import_drizzle_orm4.eq)(statusLogs.monitorId, id), (0, import_drizzle_orm4.lt)(statusLogs.checkedAt, logCutoff)));
  }
  await pruneDailyStats(db, dayOf(now) - intSetting(all, "stats_retention_days", 400));
}
async function runCron(env) {
  const db = getDb(env.DB);
  const now = Math.floor(Date.now() / 1e3);
  const allSettings = await loadSettings(db);
  const locale = allSettings["locale"] ?? "en";
  await runRetention(db, allSettings, now);
  const allMonitors = await db.select().from(monitors).where((0, import_drizzle_orm4.eq)(monitors.active, true));
  const due = allMonitors.filter((m) => {
    if (!m.lastCheckedAt) return true;
    return now - m.lastCheckedAt >= m.interval;
  });
  if (due.length === 0) return;
  const origin = await getWorkerOrigin();
  const transitioned = [];
  await Promise.allSettled(due.map(async (monitor) => {
    const logRow = {
      id: crypto.randomUUID(),
      monitorId: monitor.id,
      checkedAt: now,
      colo: origin?.colo ?? null,
      countryCode: origin?.countryCode ?? null,
      originIp: origin?.originIp ?? null
    };
    try {
      if (monitor.type === "http") {
        const result = await checkHttp(monitor, locale);
        await db.insert(statusLogs).values({
          ...logRow,
          status: result.status,
          message: result.message,
          responseTimeMs: result.responseTimeMs
        });
        await recordCheck(db, monitor.id, now, result.status, result.responseTimeMs ?? null);
        if (monitor.lastStatus !== result.status) transitioned.push(monitor.id);
        if (monitor.sslCheckEnabled && monitor.url?.startsWith("https://")) {
          const newSslStatus = result.sslError ? "error" : result.status === "up" ? "ok" : monitor.sslStatus;
          if (newSslStatus !== monitor.sslStatus) {
            await db.update(monitors).set({ sslStatus: newSslStatus }).where((0, import_drizzle_orm4.eq)(monitors.id, monitor.id));
          }
        }
        await processAlert({
          db,
          monitor,
          status: result.status,
          message: result.message,
          responseTimeMs: result.responseTimeMs,
          locale,
          encryptionKey: env.ENCRYPTION_KEY
        });
      } else if (monitor.type === "heartbeat") {
        const hb = await db.query.heartbeatTokens.findFirst({
          where: (0, import_drizzle_orm4.eq)(heartbeatTokens.monitorId, monitor.id)
        });
        const result = checkHeartbeat(monitor, hb?.lastPingAt ?? null, now, locale);
        await db.insert(statusLogs).values({
          ...logRow,
          status: result.status,
          message: result.logKey ?? result.message,
          responseTimeMs: null
        });
        await recordCheck(db, monitor.id, now, result.status, null);
        if (monitor.lastStatus !== result.status) transitioned.push(monitor.id);
        await processAlert({
          db,
          monitor,
          status: result.status,
          message: result.message,
          locale,
          encryptionKey: env.ENCRYPTION_KEY
        });
      }
    } catch (err) {
      await db.insert(statusLogs).values({
        ...logRow,
        status: "down",
        message: `Internal error: ${String(err)}`,
        responseTimeMs: null
      }).catch(() => {
      });
      await recordCheck(db, monitor.id, now, "down", null).catch(() => {
      });
    }
  }));
  if (transitioned.length > 0) {
    await invalidate(env, cacheKeys.overview(), ...transitioned.map(cacheKeys.monitor));
    await invalidatePublicPages(db, env, transitioned);
  }
}
async function invalidatePublicPages(db, env, monitorIds) {
  try {
    const pages = await db.select({ slug: statusPages.slug }).from(statusPages);
    const keys = pages.flatMap((p) => [
      cacheKeys.publicPage(p.slug),
      ...monitorIds.map((id) => cacheKeys.publicMonitor(p.slug, id))
    ]);
    await invalidate(env, ...keys);
  } catch (err) {
    console.error("[cron] status page cache invalidation failed", err);
  }
}

// src/middleware/auth.ts
var import_factory = require("hono/factory");
var import_jose = require("jose");
function isAuthDisabled(env) {
  const v = env.AUTH_DISABLED;
  return v === "true" || v === "1";
}
var requireAuth = (0, import_factory.createMiddleware)(async (c, next) => {
  if (isAuthDisabled(c.env)) return next();
  const authorization = c.req.header("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const token = authorization.slice(7);
  try {
    const key = new TextEncoder().encode(c.env.JWT_SECRET);
    await (0, import_jose.jwtVerify)(token, key);
    await next();
  } catch {
    return c.json({ error: "Invalid token" }, 401);
  }
});

// src/routes/auth.ts
var import_hono = require("hono");
var import_jose2 = require("jose");
var auth = new import_hono.Hono();
async function issueToken(sub, secret) {
  const key = new TextEncoder().encode(secret);
  return new import_jose2.SignJWT({ sub }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("30d").sign(key);
}
auth.get("/config", (c) => c.json({ authDisabled: isAuthDisabled(c.env) }));
auth.post("/login", async (c) => {
  const body = await c.req.json();
  if (!c.env.ADMIN_USER || !c.env.ADMIN_PASS || !c.env.JWT_SECRET) {
    return c.json({ error: "Password login is not configured" }, 400);
  }
  if (body.username !== c.env.ADMIN_USER || body.password !== c.env.ADMIN_PASS) {
    return c.json({ error: "Invalid credentials" }, 401);
  }
  const token = await issueToken(c.env.ADMIN_USER, c.env.JWT_SECRET);
  return c.json({ token });
});
auth.post("/refresh", async (c) => {
  const authorization = c.req.header("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const oldToken = authorization.slice(7);
  try {
    const key = new TextEncoder().encode(c.env.JWT_SECRET);
    await (0, import_jose2.jwtVerify)(oldToken, key);
  } catch {
    return c.json({ error: "Invalid token" }, 401);
  }
  const token = await issueToken(c.env.ADMIN_USER, c.env.JWT_SECRET);
  return c.json({ token });
});
var auth_default = auth;

// src/routes/monitors.ts
var import_hono2 = require("hono");
var import_drizzle_orm5 = require("drizzle-orm");
var router = new import_hono2.Hono();
router.use("*", requireAuth);
router.get("/", async (c) => {
  const db = getDb(c.env.DB);
  const rows = await db.select().from(monitors);
  return c.json(rows);
});
router.get("/overview", async (c) => {
  const db = getDb(c.env.DB);
  const now = Math.floor(Date.now() / 1e3);
  const [rows, allSettings] = await Promise.all([
    db.select().from(monitors),
    loadSettings(db)
  ]);
  const ids = rows.map((r) => r.id);
  const uptime = await cached(c.env, cacheKeys.overview(), cacheTtl(allSettings), async () => {
    const totals = await uptimeBulk(db, ids, 30, now);
    return Object.fromEntries([...totals].map(([id, t]) => [id, t.uptime]));
  });
  return c.json({
    monitors: rows,
    uptime30: uptime
  });
});
router.get("/:id", async (c) => {
  const db = getDb(c.env.DB);
  const monitor = await db.query.monitors.findFirst({
    where: (0, import_drizzle_orm5.eq)(monitors.id, c.req.param("id"))
  });
  if (!monitor) return c.json({ error: "Not found" }, 404);
  return c.json(monitor);
});
router.post("/", async (c) => {
  const db = getDb(c.env.DB);
  const body = await c.req.json();
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1e3);
  await db.insert(monitors).values({
    id,
    name: body.name,
    type: body.type,
    tags: JSON.stringify(body.tags ?? []),
    interval: body.interval ?? 60,
    active: body.active ?? true,
    lastStatus: "pending",
    reminderIntervalHours: body.reminderIntervalHours ?? null,
    toleranceFailures: body.toleranceFailures ?? 1,
    url: body.url ?? null,
    method: body.method ?? "GET",
    body: body.body ?? null,
    headers: JSON.stringify(body.headers ?? {}),
    expectedStatus: body.expectedStatus ?? 200,
    followRedirects: body.followRedirects ?? true,
    timeout: body.timeout ?? 30,
    ipVersion: body.ipVersion ?? "auto",
    authType: body.authType ?? "none",
    authUsername: body.authUsername ?? null,
    authPassword: body.authPassword ?? null,
    authToken: body.authToken ?? null,
    heartbeatInterval: body.heartbeatInterval ?? null,
    heartbeatGrace: body.heartbeatGrace ?? 30,
    toleranceMissed: body.toleranceMissed ?? 1,
    surgeProtectionLimit: body.surgeProtectionLimit ?? null,
    sslCheckEnabled: body.sslCheckEnabled ?? false,
    cacheBooster: body.cacheBooster ?? false,
    createdAt: now,
    updatedAt: now
  });
  await db.insert(alertState).values({ monitorId: id });
  if (body.type === "heartbeat") {
    await db.insert(heartbeatTokens).values({
      monitorId: id,
      token: crypto.randomUUID()
    });
  }
  if (Array.isArray(body.channelIds)) {
    for (const channelId of body.channelIds) {
      await db.insert(monitorNotifications).values({ monitorId: id, channelId });
    }
  }
  await invalidate(c.env, cacheKeys.overview());
  const created = await db.query.monitors.findFirst({ where: (0, import_drizzle_orm5.eq)(monitors.id, id) });
  return c.json(created, 201);
});
router.put("/:id", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const body = await c.req.json();
  const now = Math.floor(Date.now() / 1e3);
  const existing = await db.query.monitors.findFirst({ where: (0, import_drizzle_orm5.eq)(monitors.id, id) });
  if (!existing) return c.json({ error: "Not found" }, 404);
  await db.update(monitors).set({
    name: body.name ?? existing.name,
    tags: body.tags !== void 0 ? JSON.stringify(body.tags) : existing.tags,
    interval: body.interval ?? existing.interval,
    active: body.active ?? existing.active,
    reminderIntervalHours: body.reminderIntervalHours ?? existing.reminderIntervalHours,
    toleranceFailures: body.toleranceFailures ?? existing.toleranceFailures,
    url: body.url ?? existing.url,
    method: body.method ?? existing.method,
    body: body.body ?? existing.body,
    headers: body.headers !== void 0 ? JSON.stringify(body.headers) : existing.headers,
    expectedStatus: body.expectedStatus ?? existing.expectedStatus,
    followRedirects: body.followRedirects ?? existing.followRedirects,
    timeout: body.timeout ?? existing.timeout,
    ipVersion: body.ipVersion ?? existing.ipVersion,
    authType: body.authType ?? existing.authType,
    authUsername: body.authUsername ?? existing.authUsername,
    authPassword: body.authPassword ?? existing.authPassword,
    authToken: body.authToken ?? existing.authToken,
    heartbeatInterval: body.heartbeatInterval ?? existing.heartbeatInterval,
    heartbeatGrace: body.heartbeatGrace ?? existing.heartbeatGrace,
    toleranceMissed: body.toleranceMissed ?? existing.toleranceMissed,
    surgeProtectionLimit: body.surgeProtectionLimit ?? existing.surgeProtectionLimit,
    sslCheckEnabled: body.sslCheckEnabled ?? existing.sslCheckEnabled,
    cacheBooster: body.cacheBooster ?? existing.cacheBooster,
    updatedAt: now
  }).where((0, import_drizzle_orm5.eq)(monitors.id, id));
  if (Array.isArray(body.channelIds)) {
    await db.delete(monitorNotifications).where((0, import_drizzle_orm5.eq)(monitorNotifications.monitorId, id));
    for (const channelId of body.channelIds) {
      await db.insert(monitorNotifications).values({ monitorId: id, channelId });
    }
  }
  const updated = await db.query.monitors.findFirst({ where: (0, import_drizzle_orm5.eq)(monitors.id, id) });
  return c.json(updated);
});
router.delete("/:id", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  await db.delete(monitors).where((0, import_drizzle_orm5.eq)(monitors.id, id));
  await invalidate(c.env, cacheKeys.overview(), cacheKeys.monitor(id));
  return c.json({ ok: true });
});
router.get("/:id/heartbeat-token", async (c) => {
  const db = getDb(c.env.DB);
  const token = await db.query.heartbeatTokens.findFirst({
    where: (0, import_drizzle_orm5.eq)(heartbeatTokens.monitorId, c.req.param("id"))
  });
  if (!token) return c.json({ error: "Not a heartbeat monitor" }, 404);
  return c.json(token);
});
router.post("/:id/heartbeat-token/regenerate", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const newToken = crypto.randomUUID();
  await db.update(heartbeatTokens).set({ token: newToken }).where((0, import_drizzle_orm5.eq)(heartbeatTokens.monitorId, id));
  return c.json({ token: newToken });
});
router.post("/:id/reset-stats", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const monitor = await db.query.monitors.findFirst({ where: (0, import_drizzle_orm5.eq)(monitors.id, id) });
  if (!monitor) return c.json({ error: "Not found" }, 404);
  await db.delete(statusLogs).where((0, import_drizzle_orm5.eq)(statusLogs.monitorId, id));
  await db.delete(dailyStats).where((0, import_drizzle_orm5.eq)(dailyStats.monitorId, id));
  await db.delete(incidents).where((0, import_drizzle_orm5.eq)(incidents.monitorId, id));
  await db.update(alertState).set({
    consecutiveFailures: 0,
    consecutiveMissed: 0,
    alertSentAt: null,
    consecutiveAlerts: 0,
    lastReminderAt: null,
    surgePausedUntil: null
  }).where((0, import_drizzle_orm5.eq)(alertState.monitorId, id));
  await db.update(monitors).set({
    lastStatus: "pending",
    lastCheckedAt: null
  }).where((0, import_drizzle_orm5.eq)(monitors.id, id));
  await invalidate(c.env, cacheKeys.overview(), cacheKeys.monitor(id));
  return c.json({ ok: true });
});
router.get("/:id/channels", async (c) => {
  const db = getDb(c.env.DB);
  const rows = await db.select().from(monitorNotifications).where((0, import_drizzle_orm5.eq)(monitorNotifications.monitorId, c.req.param("id")));
  return c.json(rows.map((r) => r.channelId));
});
var monitors_default = router;

// src/routes/heartbeat.ts
var import_hono3 = require("hono");
var import_drizzle_orm6 = require("drizzle-orm");
var router2 = new import_hono3.Hono();
async function handleHeartbeat(c) {
  const db = getDb(c.env.DB);
  const token = c.req.param("token");
  const now = Math.floor(Date.now() / 1e3);
  const hb = await db.query.heartbeatTokens.findFirst({
    where: (0, import_drizzle_orm6.eq)(heartbeatTokens.token, token)
  });
  if (!hb) return c.json({ error: "Unknown heartbeat token" }, 404);
  const monitor = await db.query.monitors.findFirst({
    where: (0, import_drizzle_orm6.eq)(monitors.id, hb.monitorId)
  });
  if (!monitor || !monitor.active) return c.json({ error: "Monitor not active" }, 400);
  const locale = await getLocale(db);
  const receivedMsg = msgHeartbeatReceived(locale);
  await db.update(heartbeatTokens).set({ lastPingAt: now }).where((0, import_drizzle_orm6.eq)(heartbeatTokens.token, token));
  await db.insert(statusLogs).values({
    id: crypto.randomUUID(),
    monitorId: monitor.id,
    status: "up",
    message: "notify.heartbeatReceived",
    responseTimeMs: null,
    checkedAt: now
  });
  await recordCheck(db, monitor.id, now, "up", null);
  await processAlert({ db, monitor, status: "up", message: receivedMsg, locale });
  if (monitor.lastStatus !== "up") {
    await invalidate(c.env, cacheKeys.overview(), cacheKeys.monitor(monitor.id));
  }
  return new Response(null, {
    status: 200,
    headers: { "content-type": "application/json", "content-length": "0" }
  });
}
router2.on(["GET", "POST"], "/:token", handleHeartbeat);
router2.on(["GET", "POST"], "/:token/*", handleHeartbeat);
var heartbeat_default = router2;

// src/routes/history.ts
var import_hono4 = require("hono");
var import_drizzle_orm7 = require("drizzle-orm");
var router3 = new import_hono4.Hono();
router3.use("*", requireAuth);
var MAX_LOG_LIMIT = 1e3;
var DEFAULT_SUMMARY_LOGS = 300;
function clampLimit(raw, fallback) {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), MAX_LOG_LIMIT);
}
function recentLogs(db, monitorId, limit, since) {
  return db.select().from(statusLogs).where(since !== null ? (0, import_drizzle_orm7.and)((0, import_drizzle_orm7.eq)(statusLogs.monitorId, monitorId), (0, import_drizzle_orm7.gte)(statusLogs.checkedAt, since)) : (0, import_drizzle_orm7.eq)(statusLogs.monitorId, monitorId)).orderBy((0, import_drizzle_orm7.desc)(statusLogs.checkedAt)).limit(limit);
}
function monitorIncidents(db, monitorId, limit) {
  return db.select().from(incidents).where((0, import_drizzle_orm7.eq)(incidents.monitorId, monitorId)).orderBy((0, import_drizzle_orm7.desc)(incidents.startedAt)).limit(limit);
}
router3.get("/:id/logs", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const hoursParam = c.req.query("hours");
  const hours = hoursParam !== void 0 ? Number(hoursParam) : null;
  const limit = clampLimit(c.req.query("limit"), 500);
  const since = hours !== null && hours > 0 ? Math.floor(Date.now() / 1e3) - hours * 3600 : null;
  return c.json(await recentLogs(db, id, limit, since));
});
router3.get("/:id/check-count", async (c) => {
  const db = getDb(c.env.DB);
  return c.json({ count: await checkCount(db, c.req.param("id")) });
});
router3.get("/:id/incidents", async (c) => {
  const db = getDb(c.env.DB);
  const limit = clampLimit(c.req.query("limit"), 50);
  return c.json(await monitorIncidents(db, c.req.param("id"), limit));
});
router3.get("/:id/uptime", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const days = Number(c.req.query("days") ?? 90);
  const now = Math.floor(Date.now() / 1e3);
  const { uptime, total, ups } = await uptimeForDays(db, id, days, now);
  return c.json({ uptime, days, total, up: ups });
});
router3.get("/:id/daily", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const days = Number(c.req.query("days") ?? 90);
  const now = Math.floor(Date.now() / 1e3);
  const monitor = await db.query.monitors.findFirst({ where: (0, import_drizzle_orm7.eq)(monitors.id, id) });
  if (!monitor) return c.json({ error: "Not found" }, 404);
  return c.json(await dailySeries(db, id, days, now));
});
router3.get("/:id/summary", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const now = Math.floor(Date.now() / 1e3);
  const logLimit = clampLimit(c.req.query("logs"), DEFAULT_SUMMARY_LOGS);
  const monitor = await db.query.monitors.findFirst({ where: (0, import_drizzle_orm7.eq)(monitors.id, id) });
  if (!monitor) return c.json({ error: "Not found" }, 404);
  const [logs, incidentRows, allSettings] = await Promise.all([
    recentLogs(db, id, logLimit, null),
    monitorIncidents(db, id, 50),
    loadSettings(db)
  ]);
  const history = await cached(c.env, cacheKeys.monitor(id), cacheTtl(allSettings), async () => {
    const [daily, u1, u7, u30, u90, count, avgMs] = await Promise.all([
      dailySeries(db, id, 90, now),
      uptimeForDays(db, id, 1, now),
      uptimeForDays(db, id, 7, now),
      uptimeForDays(db, id, 30, now),
      uptimeForDays(db, id, 90, now),
      checkCount(db, id),
      avgResponseMs(db, id, now - SECONDS_PER_DAY)
    ]);
    return {
      daily,
      uptime1: u1.uptime,
      uptime7: u7.uptime,
      uptime30: u30.uptime,
      uptime90: u90.uptime,
      checkCount: count,
      avgResponseMs: avgMs
    };
  });
  return c.json({ monitor, logs, incidents: incidentRows, ...history });
});
var history_default = router3;

// src/routes/notifications.ts
var import_hono5 = require("hono");
var import_drizzle_orm8 = require("drizzle-orm");
var router4 = new import_hono5.Hono();
router4.use("*", requireAuth);
function sanitizeChannel(ch) {
  const config = JSON.parse(ch.config);
  const sensitiveKeys = SENSITIVE_FIELDS[ch.type] ?? [];
  const encryptedFields = [];
  for (const key of sensitiveKeys) {
    if (config[key] && isEncryptedValue(config[key])) {
      encryptedFields.push(key);
      config[key] = "";
    }
  }
  return { ...ch, config: JSON.stringify(config), encryptedFields };
}
async function encryptSensitiveFields(config, type, encryptionKey) {
  const result = { ...config };
  for (const key of SENSITIVE_FIELDS[type] ?? []) {
    if (result[key] && result[key].length > 0 && !isEncryptedValue(result[key])) {
      result[key] = await encryptField(result[key], encryptionKey);
    }
  }
  return result;
}
router4.get("/", async (c) => {
  const db = getDb(c.env.DB);
  const channels = await db.select().from(notificationChannels);
  return c.json(channels.map(sanitizeChannel));
});
router4.get("/:id", async (c) => {
  const db = getDb(c.env.DB);
  const ch = await db.query.notificationChannels.findFirst({
    where: (0, import_drizzle_orm8.eq)(notificationChannels.id, c.req.param("id"))
  });
  if (!ch) return c.json({ error: "Not found" }, 404);
  return c.json(sanitizeChannel(ch));
});
router4.post("/", async (c) => {
  const db = getDb(c.env.DB);
  const body = await c.req.json();
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1e3);
  let config = body.config ?? {};
  config = await encryptSensitiveFields(config, body.type, c.env.ENCRYPTION_KEY);
  await db.insert(notificationChannels).values({
    id,
    name: body.name,
    type: body.type,
    config: JSON.stringify(config),
    active: body.active ?? true,
    isDefault: body.isDefault ?? false,
    createdAt: now
  });
  const created = await db.query.notificationChannels.findFirst({
    where: (0, import_drizzle_orm8.eq)(notificationChannels.id, id)
  });
  return c.json(sanitizeChannel(created), 201);
});
router4.put("/:id", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const body = await c.req.json();
  const existing = await db.query.notificationChannels.findFirst({
    where: (0, import_drizzle_orm8.eq)(notificationChannels.id, id)
  });
  if (!existing) return c.json({ error: "Not found" }, 404);
  let newConfig;
  if (body.config !== void 0) {
    const existingConfig = JSON.parse(existing.config);
    const incomingConfig = body.config;
    const mergedConfig = { ...existingConfig, ...incomingConfig };
    for (const key of SENSITIVE_FIELDS[existing.type] ?? []) {
      const incoming = incomingConfig[key];
      if (!incoming || incoming.length === 0) {
        mergedConfig[key] = existingConfig[key] ?? "";
      } else if (!isEncryptedValue(incoming)) {
        mergedConfig[key] = await encryptField(incoming, c.env.ENCRYPTION_KEY);
      }
    }
    newConfig = mergedConfig;
  }
  await db.update(notificationChannels).set({
    name: body.name ?? existing.name,
    type: body.type ?? existing.type,
    config: newConfig !== void 0 ? JSON.stringify(newConfig) : existing.config,
    active: body.active ?? existing.active,
    isDefault: body.isDefault !== void 0 ? body.isDefault : existing.isDefault
  }).where((0, import_drizzle_orm8.eq)(notificationChannels.id, id));
  const updated = await db.query.notificationChannels.findFirst({
    where: (0, import_drizzle_orm8.eq)(notificationChannels.id, id)
  });
  return c.json(sanitizeChannel(updated));
});
router4.delete("/:id", async (c) => {
  const db = getDb(c.env.DB);
  await db.delete(notificationChannels).where((0, import_drizzle_orm8.eq)(notificationChannels.id, c.req.param("id")));
  return c.json({ ok: true });
});
router4.post("/:id/apply-all-monitors", async (c) => {
  const db = getDb(c.env.DB);
  const channelId = c.req.param("id");
  const ch = await db.query.notificationChannels.findFirst({
    where: (0, import_drizzle_orm8.eq)(notificationChannels.id, channelId)
  });
  if (!ch) return c.json({ error: "Not found" }, 404);
  const allMonitors = await db.select().from(monitors);
  for (const monitor of allMonitors) {
    await db.insert(monitorNotifications).values({ monitorId: monitor.id, channelId }).onConflictDoNothing();
  }
  return c.json({ ok: true, applied: allMonitors.length });
});
router4.post("/:id/test", async (c) => {
  const db = getDb(c.env.DB);
  const ch = await db.query.notificationChannels.findFirst({
    where: (0, import_drizzle_orm8.eq)(notificationChannels.id, c.req.param("id"))
  });
  if (!ch) return c.json({ error: "Not found" }, 404);
  try {
    await sendNotification(ch, {
      type: "callback",
      monitor: { id: "test", name: "Test Monitor", type: "http", url: "https://example.com" },
      status: "up",
      message: "This is a test notification from Pingflare."
    }, c.env.ENCRYPTION_KEY);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});
var notifications_default = router4;

// src/routes/settings.ts
var import_hono6 = require("hono");
var app = new import_hono6.Hono();
app.use("*", requireAuth);
app.get("/", async (c) => {
  const db = getDb(c.env.DB);
  const rows = await db.select().from(settings);
  const result = {};
  for (const row of rows) result[row.key] = row.value;
  return c.json(result);
});
app.put("/", async (c) => {
  const body = await c.req.json();
  const db = getDb(c.env.DB);
  for (const [key, value] of Object.entries(body)) {
    await db.insert(settings).values({ key, value: String(value) }).onConflictDoUpdate({ target: settings.key, set: { value: String(value) } });
  }
  const rows = await db.select().from(settings);
  const result = {};
  for (const row of rows) result[row.key] = row.value;
  await invalidate(c.env, cacheKeys.overview());
  return c.json(result);
});
app.post("/rebuild-stats", async (c) => {
  await rebuildDailyStats(c.env.DB);
  await invalidate(c.env, cacheKeys.overview());
  return c.json({ ok: true });
});
var settings_default = app;

// src/routes/statusPages.ts
var import_hono7 = require("hono");
var import_drizzle_orm9 = require("drizzle-orm");
var router5 = new import_hono7.Hono();
router5.use("*", requireAuth);
router5.get("/", async (c) => {
  const db = getDb(c.env.DB);
  const rows = await db.select().from(statusPages);
  return c.json(rows);
});
router5.post("/", async (c) => {
  const db = getDb(c.env.DB);
  const body = await c.req.json();
  const id = crypto.randomUUID();
  let passwordHash = null;
  if (body.password) passwordHash = await hashPassword(body.password);
  await db.insert(statusPages).values({
    id,
    name: body.name,
    slug: body.slug,
    description: body.description ?? null,
    passwordHash,
    showAllMonitors: body.showAllMonitors ?? false
  });
  if (Array.isArray(body.monitorIds)) {
    for (let i = 0; i < body.monitorIds.length; i++) {
      await db.insert(statusPageMonitors).values({ pageId: id, monitorId: body.monitorIds[i], sortOrder: i });
    }
  }
  const created = await db.query.statusPages.findFirst({ where: (0, import_drizzle_orm9.eq)(statusPages.id, id) });
  return c.json(created, 201);
});
router5.get("/:id", async (c) => {
  const db = getDb(c.env.DB);
  const page = await db.query.statusPages.findFirst({ where: (0, import_drizzle_orm9.eq)(statusPages.id, c.req.param("id")) });
  if (!page) return c.json({ error: "Not found" }, 404);
  return c.json(page);
});
router5.put("/:id", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const body = await c.req.json();
  const existing = await db.query.statusPages.findFirst({ where: (0, import_drizzle_orm9.eq)(statusPages.id, id) });
  if (!existing) return c.json({ error: "Not found" }, 404);
  let passwordHash = existing.passwordHash;
  if (body.password === "") {
    passwordHash = null;
  } else if (body.password) {
    passwordHash = await hashPassword(body.password);
  }
  await db.update(statusPages).set({
    name: body.name ?? existing.name,
    slug: body.slug ?? existing.slug,
    description: body.description !== void 0 ? body.description : existing.description,
    passwordHash,
    showAllMonitors: body.showAllMonitors !== void 0 ? body.showAllMonitors : existing.showAllMonitors
  }).where((0, import_drizzle_orm9.eq)(statusPages.id, id));
  if (Array.isArray(body.monitorIds)) {
    await db.delete(statusPageMonitors).where((0, import_drizzle_orm9.eq)(statusPageMonitors.pageId, id));
    for (let i = 0; i < body.monitorIds.length; i++) {
      await db.insert(statusPageMonitors).values({ pageId: id, monitorId: body.monitorIds[i], sortOrder: i });
    }
  }
  const updated = await db.query.statusPages.findFirst({ where: (0, import_drizzle_orm9.eq)(statusPages.id, id) });
  return c.json(updated);
});
router5.delete("/:id", async (c) => {
  const db = getDb(c.env.DB);
  await db.delete(statusPages).where((0, import_drizzle_orm9.eq)(statusPages.id, c.req.param("id")));
  return c.json({ ok: true });
});
router5.get("/:id/monitors", async (c) => {
  const db = getDb(c.env.DB);
  const rows = await db.select().from(statusPageMonitors).where((0, import_drizzle_orm9.eq)(statusPageMonitors.pageId, c.req.param("id")));
  return c.json(rows.map((r) => r.monitorId));
});
var statusPages_default = router5;

// src/routes/publicStatus.ts
var import_hono8 = require("hono");
var import_drizzle_orm10 = require("drizzle-orm");
var router6 = new import_hono8.Hono();
var PUBLIC_LOG_LIMIT = 200;
async function checkPassword(page, provided) {
  if (!page.passwordHash) return "ok";
  if (!provided) return "password_required";
  return await verifyPassword(provided, page.passwordHash) ? "ok" : "wrong_password";
}
async function resolveMonitors(db, page) {
  if (page.showAllMonitors) {
    const rows2 = await db.select().from(monitors).where((0, import_drizzle_orm10.eq)(monitors.active, true));
    rows2.sort((a, b) => a.name.localeCompare(b.name));
    return { ids: rows2.map((r) => r.id), rows: rows2 };
  }
  const pageMonitorRows = await db.select().from(statusPageMonitors).where((0, import_drizzle_orm10.eq)(statusPageMonitors.pageId, page.id));
  pageMonitorRows.sort((a, b) => a.sortOrder - b.sortOrder);
  const ids = pageMonitorRows.map((r) => r.monitorId);
  if (ids.length === 0) return { ids, rows: [] };
  const rows = await db.select().from(monitors).where((0, import_drizzle_orm10.inArray)(monitors.id, ids));
  return { ids, rows };
}
router6.get("/:slug", async (c) => {
  const db = getDb(c.env.DB);
  const slug = c.req.param("slug");
  const page = await db.query.statusPages.findFirst({ where: (0, import_drizzle_orm10.eq)(statusPages.slug, slug) });
  if (!page) return c.json({ error: "Not found" }, 404);
  const pageInfo = { name: page.name, description: page.description };
  const auth2 = await checkPassword(page, c.req.header("x-status-password") ?? c.req.query("password"));
  if (auth2 !== "ok") return c.json({ error: auth2, protected: true, page: pageInfo }, 401);
  const now = Math.floor(Date.now() / 1e3);
  const { ids: monitorIds, rows: monitorRows } = await resolveMonitors(db, page);
  if (monitorIds.length === 0) {
    return c.json({
      page: { ...pageInfo, protected: !!page.passwordHash },
      monitors: [],
      incidents: []
    });
  }
  const allSettings = await loadSettings(db);
  const history = await cached(c.env, cacheKeys.publicPage(slug), cacheTtl(allSettings), async () => {
    const [daily, uptime] = await Promise.all([
      dailySeriesBulk(db, monitorIds, 90, now),
      uptimeBulk(db, monitorIds, 90, now)
    ]);
    return {
      daily: Object.fromEntries(daily),
      uptime90d: Object.fromEntries([...uptime].map(([id, t]) => [id, t.uptime])),
      incidents: await publicIncidents(db, monitorIds, now)
    };
  });
  const byId = new Map(monitorRows.map((m) => [m.id, m]));
  const monitorData = monitorIds.map((id) => {
    const m = byId.get(id);
    if (!m) return null;
    return {
      id: m.id,
      name: m.name,
      status: m.lastStatus,
      uptime90d: history.uptime90d[id] ?? null,
      daily: history.daily[id] ?? []
    };
  }).filter((m) => m !== null);
  return c.json({
    page: { ...pageInfo, protected: !!page.passwordHash },
    monitors: monitorData,
    incidents: history.incidents
  });
});
async function publicIncidents(db, monitorIds, now) {
  const incMonitorRows = await db.select().from(incidentMonitors).where((0, import_drizzle_orm10.inArray)(incidentMonitors.monitorId, monitorIds));
  const incidentIds = [...new Set(incMonitorRows.map((r) => r.incidentId))];
  if (incidentIds.length === 0) return [];
  const since14d = now - 14 * SECONDS_PER_DAY;
  const incRows = await db.select().from(incidentReports).where((0, import_drizzle_orm10.inArray)(incidentReports.id, incidentIds)).orderBy((0, import_drizzle_orm10.desc)(incidentReports.startedAt)).limit(20);
  const visible = incRows.filter((inc) => !(inc.resolvedAt && inc.resolvedAt < since14d));
  if (visible.length === 0) return [];
  const updateRows = await db.select().from(incidentUpdates).where((0, import_drizzle_orm10.inArray)(incidentUpdates.incidentId, visible.map((i) => i.id))).orderBy((0, import_drizzle_orm10.desc)(incidentUpdates.createdAt));
  return visible.map((inc) => ({
    ...inc,
    updates: updateRows.filter((u) => u.incidentId === inc.id),
    monitorIds: incMonitorRows.filter((r) => r.incidentId === inc.id).map((r) => r.monitorId)
  }));
}
router6.get("/:slug/monitors/:monitorId", async (c) => {
  const db = getDb(c.env.DB);
  const slug = c.req.param("slug");
  const monitorId = c.req.param("monitorId");
  const page = await db.query.statusPages.findFirst({ where: (0, import_drizzle_orm10.eq)(statusPages.slug, slug) });
  if (!page) return c.json({ error: "Not found" }, 404);
  const auth2 = await checkPassword(page, c.req.header("x-status-password") ?? c.req.query("password"));
  if (auth2 !== "ok") return c.json({ error: auth2, protected: true }, 401);
  let monitor;
  if (page.showAllMonitors) {
    monitor = await db.query.monitors.findFirst({
      where: (0, import_drizzle_orm10.and)((0, import_drizzle_orm10.eq)(monitors.id, monitorId), (0, import_drizzle_orm10.eq)(monitors.active, true))
    });
  } else {
    const rows = await db.select().from(statusPageMonitors).where((0, import_drizzle_orm10.and)((0, import_drizzle_orm10.eq)(statusPageMonitors.pageId, page.id), (0, import_drizzle_orm10.eq)(statusPageMonitors.monitorId, monitorId)));
    if (rows.length > 0) {
      monitor = await db.query.monitors.findFirst({ where: (0, import_drizzle_orm10.eq)(monitors.id, monitorId) });
    }
  }
  if (!monitor) return c.json({ error: "Not found" }, 404);
  const now = Math.floor(Date.now() / 1e3);
  const allSettings = await loadSettings(db);
  const [logs, monitorIncidents2] = await Promise.all([
    db.select().from(statusLogs).where((0, import_drizzle_orm10.eq)(statusLogs.monitorId, monitorId)).orderBy((0, import_drizzle_orm10.desc)(statusLogs.checkedAt)).limit(PUBLIC_LOG_LIMIT),
    db.select().from(incidents).where((0, import_drizzle_orm10.eq)(incidents.monitorId, monitorId)).orderBy((0, import_drizzle_orm10.desc)(incidents.startedAt)).limit(20)
  ]);
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
        avgResponseMs(db, monitorId, now - SECONDS_PER_DAY)
      ]);
      return {
        daily,
        uptime1: u1.uptime,
        uptime7: u7.uptime,
        uptime30: u30.uptime,
        uptime90: u90.uptime,
        avgResponseMs: avgMs
      };
    }
  );
  return c.json({
    name: monitor.name,
    type: monitor.type,
    url: monitor.url,
    tags: monitor.tags,
    lastStatus: monitor.lastStatus,
    lastCheckedAt: monitor.lastCheckedAt,
    ...history,
    logs: logs.map((l) => ({
      checkedAt: l.checkedAt,
      status: l.status,
      responseTimeMs: l.responseTimeMs,
      message: l.message
    })),
    incidents: monitorIncidents2.map((i) => ({
      startedAt: i.startedAt,
      resolvedAt: i.resolvedAt,
      durationSeconds: i.durationSeconds
    }))
  });
});
var publicStatus_default = router6;

// src/routes/incidentReports.ts
var import_hono9 = require("hono");
var import_drizzle_orm11 = require("drizzle-orm");
var router7 = new import_hono9.Hono();
router7.use("*", requireAuth);
router7.get("/", async (c) => {
  const db = getDb(c.env.DB);
  const rows = await db.select().from(incidentReports).orderBy((0, import_drizzle_orm11.desc)(incidentReports.startedAt)).limit(100);
  const enriched = await Promise.all(rows.map(async (inc) => {
    const links = await db.select().from(incidentMonitors).where((0, import_drizzle_orm11.eq)(incidentMonitors.incidentId, inc.id));
    const updates = await db.select().from(incidentUpdates).where((0, import_drizzle_orm11.eq)(incidentUpdates.incidentId, inc.id)).orderBy((0, import_drizzle_orm11.desc)(incidentUpdates.createdAt));
    return { ...inc, monitorIds: links.map((r) => r.monitorId), updates };
  }));
  return c.json(enriched);
});
router7.post("/", async (c) => {
  const db = getDb(c.env.DB);
  const body = await c.req.json();
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1e3);
  await db.insert(incidentReports).values({
    id,
    title: body.title,
    status: body.status ?? "investigating",
    startedAt: now,
    resolvedAt: body.status === "resolved" ? now : null
  });
  if (body.message) {
    await db.insert(incidentUpdates).values({
      id: crypto.randomUUID(),
      incidentId: id,
      message: body.message,
      status: body.status ?? "investigating"
    });
  }
  if (Array.isArray(body.monitorIds)) {
    for (const monitorId of body.monitorIds) {
      await db.insert(incidentMonitors).values({ incidentId: id, monitorId });
    }
  }
  const created = await db.query.incidentReports.findFirst({ where: (0, import_drizzle_orm11.eq)(incidentReports.id, id) });
  return c.json(created, 201);
});
router7.get("/:id", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const incident = await db.query.incidentReports.findFirst({ where: (0, import_drizzle_orm11.eq)(incidentReports.id, id) });
  if (!incident) return c.json({ error: "Not found" }, 404);
  const updates = await db.select().from(incidentUpdates).where((0, import_drizzle_orm11.eq)(incidentUpdates.incidentId, id)).orderBy((0, import_drizzle_orm11.desc)(incidentUpdates.createdAt));
  const links = await db.select().from(incidentMonitors).where((0, import_drizzle_orm11.eq)(incidentMonitors.incidentId, id));
  return c.json({ ...incident, updates, monitorIds: links.map((r) => r.monitorId) });
});
router7.put("/:id", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const body = await c.req.json();
  const now = Math.floor(Date.now() / 1e3);
  const existing = await db.query.incidentReports.findFirst({ where: (0, import_drizzle_orm11.eq)(incidentReports.id, id) });
  if (!existing) return c.json({ error: "Not found" }, 404);
  const resolvedAt = body.status === "resolved" && !existing.resolvedAt ? now : existing.resolvedAt;
  await db.update(incidentReports).set({
    title: body.title ?? existing.title,
    status: body.status ?? existing.status,
    resolvedAt
  }).where((0, import_drizzle_orm11.eq)(incidentReports.id, id));
  if (Array.isArray(body.monitorIds)) {
    await db.delete(incidentMonitors).where((0, import_drizzle_orm11.eq)(incidentMonitors.incidentId, id));
    for (const monitorId of body.monitorIds) {
      await db.insert(incidentMonitors).values({ incidentId: id, monitorId });
    }
  }
  const updated = await db.query.incidentReports.findFirst({ where: (0, import_drizzle_orm11.eq)(incidentReports.id, id) });
  return c.json(updated);
});
router7.post("/:id/updates", async (c) => {
  const db = getDb(c.env.DB);
  const incidentId = c.req.param("id");
  const body = await c.req.json();
  const now = Math.floor(Date.now() / 1e3);
  const incident = await db.query.incidentReports.findFirst({ where: (0, import_drizzle_orm11.eq)(incidentReports.id, incidentId) });
  if (!incident) return c.json({ error: "Not found" }, 404);
  const updateId = crypto.randomUUID();
  await db.insert(incidentUpdates).values({
    id: updateId,
    incidentId,
    message: body.message,
    status: body.status
  });
  const resolvedAt = body.status === "resolved" && !incident.resolvedAt ? now : incident.resolvedAt;
  await db.update(incidentReports).set({ status: body.status, resolvedAt }).where((0, import_drizzle_orm11.eq)(incidentReports.id, incidentId));
  const update = await db.query.incidentUpdates.findFirst({ where: (0, import_drizzle_orm11.eq)(incidentUpdates.id, updateId) });
  return c.json(update, 201);
});
router7.delete("/:id", async (c) => {
  const db = getDb(c.env.DB);
  await db.delete(incidentReports).where((0, import_drizzle_orm11.eq)(incidentReports.id, c.req.param("id")));
  return c.json({ ok: true });
});
var incidentReports_default = router7;

// src/routes/backup.ts
var import_hono10 = require("hono");
var router8 = new import_hono10.Hono();
router8.use("*", requireAuth);
router8.get("/", async (c) => {
  const db = getDb(c.env.DB);
  const settingsRows = await db.select().from(settings);
  const settingsMap = {};
  for (const row of settingsRows) settingsMap[row.key] = row.value;
  const monitorsRows = await db.select().from(monitors);
  const notifRows = await db.select().from(notificationChannels);
  const statusPagesRows = await db.select().from(statusPages);
  const monitorNotifRows = await db.select().from(monitorNotifications);
  const spmRows = await db.select().from(statusPageMonitors);
  const monitorsWithChannels = monitorsRows.map((m) => ({
    ...m,
    channelIds: monitorNotifRows.filter((mn) => mn.monitorId === m.id).map((mn) => mn.channelId)
  }));
  const pagesWithMonitors = statusPagesRows.map((p) => ({
    ...p,
    monitorIds: spmRows.filter((spm) => spm.pageId === p.id).sort((a, b) => a.sortOrder - b.sortOrder).map((spm) => spm.monitorId)
  }));
  return c.json({
    version: 1,
    exportedAt: Math.floor(Date.now() / 1e3),
    settings: settingsMap,
    monitors: monitorsWithChannels,
    notifications: notifRows,
    statusPages: pagesWithMonitors
  });
});
router8.post("/restore", async (c) => {
  const body = await c.req.json();
  if (body.version !== 1) return c.json({ error: "Unsupported backup version" }, 400);
  const db = getDb(c.env.DB);
  const now = Math.floor(Date.now() / 1e3);
  await db.delete(monitors);
  await db.delete(notificationChannels);
  await db.delete(statusPages);
  await db.delete(settings);
  if (body.settings && typeof body.settings === "object") {
    for (const [key, value] of Object.entries(body.settings)) {
      await db.insert(settings).values({ key, value: String(value) });
    }
  }
  if (Array.isArray(body.notifications)) {
    for (const ch of body.notifications) {
      await db.insert(notificationChannels).values({
        id: ch.id,
        name: ch.name,
        type: ch.type,
        config: ch.config ?? "{}",
        active: ch.active ?? true,
        isDefault: ch.isDefault ?? false,
        createdAt: ch.createdAt ?? now
      });
    }
  }
  if (Array.isArray(body.monitors)) {
    for (const m of body.monitors) {
      await db.insert(monitors).values({
        id: m.id,
        name: m.name,
        type: m.type,
        tags: m.tags ?? "[]",
        interval: m.interval ?? 60,
        active: m.active ?? true,
        lastCheckedAt: null,
        lastStatus: "pending",
        reminderIntervalHours: m.reminderIntervalHours ?? null,
        toleranceFailures: m.toleranceFailures ?? 1,
        url: m.url ?? null,
        method: m.method ?? "GET",
        body: m.body ?? null,
        headers: m.headers ?? "{}",
        expectedStatus: m.expectedStatus ?? 200,
        followRedirects: m.followRedirects ?? true,
        timeout: m.timeout ?? 30,
        ipVersion: m.ipVersion ?? "auto",
        authType: m.authType ?? "none",
        authUsername: m.authUsername ?? null,
        authPassword: m.authPassword ?? null,
        authToken: m.authToken ?? null,
        heartbeatInterval: m.heartbeatInterval ?? null,
        heartbeatGrace: m.heartbeatGrace ?? 30,
        toleranceMissed: m.toleranceMissed ?? 1,
        surgeProtectionLimit: m.surgeProtectionLimit ?? null,
        sslCheckEnabled: m.sslCheckEnabled ?? false,
        sslStatus: "unknown",
        cacheBooster: m.cacheBooster ?? false,
        createdAt: m.createdAt ?? now,
        updatedAt: now
      });
      await db.insert(alertState).values({ monitorId: m.id });
      if (m.type === "heartbeat") {
        await db.insert(heartbeatTokens).values({ monitorId: m.id, token: crypto.randomUUID() });
      }
      if (Array.isArray(m.channelIds)) {
        for (const channelId of m.channelIds) {
          await db.insert(monitorNotifications).values({ monitorId: m.id, channelId });
        }
      }
    }
  }
  if (Array.isArray(body.statusPages)) {
    for (const p of body.statusPages) {
      await db.insert(statusPages).values({
        id: p.id,
        name: p.name,
        slug: p.slug,
        description: p.description ?? null,
        passwordHash: p.passwordHash ?? null,
        showAllMonitors: p.showAllMonitors ?? false,
        createdAt: p.createdAt ?? now
      });
      if (Array.isArray(p.monitorIds)) {
        for (let i = 0; i < p.monitorIds.length; i++) {
          await db.insert(statusPageMonitors).values({ pageId: p.id, monitorId: p.monitorIds[i], sortOrder: i });
        }
      }
    }
  }
  return c.json({ ok: true });
});
var backup_default = router8;

// src/routes/events.ts
var import_hono11 = require("hono");
var import_streaming = require("hono/streaming");
var import_jose3 = require("jose");
var router9 = new import_hono11.Hono();
router9.get("/", async (c) => {
  const authHeader = c.req.header("Authorization");
  const queryToken = c.req.query("token");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : queryToken;
  if (!token) return c.json({ error: "Unauthorized" }, 401);
  try {
    const key = new TextEncoder().encode(c.env.JWT_SECRET);
    await (0, import_jose3.jwtVerify)(token, key);
  } catch {
    return c.json({ error: "Invalid token" }, 401);
  }
  const database = getDb(c.env.DB);
  return (0, import_streaming.streamSSE)(c, async (stream) => {
    let alive = true;
    stream.onAbort(() => {
      alive = false;
    });
    const snapshot = await database.select().from(monitors);
    await stream.writeSSE({ event: "snapshot", data: JSON.stringify(snapshot) });
    let ticks = 0;
    while (alive) {
      await stream.sleep(3e4);
      if (!alive) break;
      ticks++;
      await stream.writeSSE({ event: "heartbeat", data: JSON.stringify({ ts: Date.now() }) });
      if (ticks % 2 === 0) {
        const updated = await database.select().from(monitors);
        await stream.writeSSE({ event: "snapshot", data: JSON.stringify(updated) });
      }
    }
  });
});
var events_default = router9;

// src/server.ts
async function main() {
  const dbPath = process.env.DB_PATH ?? import_node_path2.default.join(process.cwd(), "data", "pingflare.db");
  const { shim } = openSqlite(dbPath);
  const d1 = shim;
  await ensureSchema(d1);
  const env = {
    DB: d1,
    ASSETS: void 0,
    // not used in Node.js path
    ADMIN_USER: process.env.ADMIN_USER ?? "",
    ADMIN_PASS: process.env.ADMIN_PASS ?? "",
    JWT_SECRET: process.env.JWT_SECRET ?? "",
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? "",
    AUTH_DISABLED: process.env.AUTH_DISABLED
  };
  const required = isAuthDisabled(env) ? ["ENCRYPTION_KEY"] : ["ADMIN_USER", "ADMIN_PASS", "JWT_SECRET", "ENCRYPTION_KEY"];
  const missing = required.filter((k) => !env[k]);
  if (missing.length > 0) {
    console.error(`Missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
  if (isAuthDisabled(env)) {
    console.warn("[auth] AUTH_DISABLED is set - the API is unauthenticated. Only run this behind a trusted proxy.");
  }
  const app2 = new import_hono12.Hono();
  app2.use("/api/*", (0, import_cors.cors)());
  app2.route("/api/auth", auth_default);
  app2.route("/api/monitors", monitors_default);
  app2.route("/h", heartbeat_default);
  app2.route("/api/monitors", history_default);
  app2.route("/api/notifications", notifications_default);
  app2.route("/api/settings", settings_default);
  app2.route("/api/status-pages", statusPages_default);
  app2.route("/api/public/status", publicStatus_default);
  app2.route("/api/incidents", incidentReports_default);
  app2.route("/api/backup", backup_default);
  app2.route("/api/events", events_default);
  app2.get("/api/health", (c) => c.json({ ok: true, ts: Date.now() }));
  app2.post("/api/cron/run", requireAuth, async (c) => {
    await runCron(c.env);
    return c.json({ ok: true, triggeredAt: Date.now() });
  });
  const staticRoot = import_node_path2.default.join(process.cwd(), "frontend", "build");
  app2.use("*", (0, import_serve_static.serveStatic)({ root: staticRoot }));
  app2.get("*", (0, import_serve_static.serveStatic)({ path: import_node_path2.default.join(staticRoot, "index.html") }));
  (0, import_node_cron.schedule)("* * * * *", () => {
    runCron(env).catch((err) => console.error("[cron]", err));
  });
  const port = parseInt(process.env.PORT ?? "3000", 10);
  (0, import_node_server.serve)(
    {
      // Inject env bindings as the second fetch argument (c.env in all routes)
      fetch: (req) => app2.fetch(req, env),
      port
    },
    (info) => console.log(`Pingflare running on http://0.0.0.0:${info.port}`)
  );
}
main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
