# API

All authenticated endpoints require an `Authorization: Bearer <token>` header
Obtain a token by calling `POST /api/auth/login`

---

## Authentication

| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/login` | Returns a JWT token valid for 30 days |
| POST | `/api/auth/refresh` | Exchanges a valid token for a new one with a fresh 30-day expiry |
| GET  | `/api/auth/config` | Public. `{ authDisabled }` — true when `AUTH_DISABLED` is set and the bearer token is not required |

With `AUTH_DISABLED=true` every authenticated endpoint below accepts requests with
no `Authorization` header at all, and `POST /api/auth/login` returns `400` unless
the credential env vars are also set. See "Bypassing the login" in the README.

---

## Monitors

| Method | Path | Description |
|---|---|---|
| GET | `/api/monitors` | List all monitors |
| GET | `/api/monitors/overview` | **Preferred for dashboards.** All monitors plus their 30-day uptime in one request |
| POST | `/api/monitors` | Create a monitor |
| GET | `/api/monitors/:id` | Get a monitor |
| PUT | `/api/monitors/:id` | Update a monitor |
| DELETE | `/api/monitors/:id` | Delete a monitor |
| GET | `/api/monitors/:id/summary` | **Preferred for detail views.** Monitor, recent checks, incidents, 90-day chart and all uptime windows in one request. Supports `?logs=300` |
| GET | `/api/monitors/:id/logs` | Status logs, supports `?hours=24&limit=500` (capped at 1000) |
| GET | `/api/monitors/:id/incidents` | Downtime incidents |
| GET | `/api/monitors/:id/uptime` | Uptime percentage, supports `?days=90` |
| GET | `/api/monitors/:id/daily` | Per-day uptime breakdown, supports `?days=90` |
| GET | `/api/monitors/:id/heartbeat-token` | Get heartbeat token |
| POST | `/api/monitors/:id/heartbeat-token/regenerate` | Rotate heartbeat token |
| GET | `/api/monitors/:id/channels` | Notification channel IDs linked to the monitor |

---

## Heartbeat

| Method | Path | Description |
|---|---|---|
| GET or POST | `/h/:token` | Register a heartbeat ping |

---

## Notifications

| Method | Path | Description |
|---|---|---|
| GET | `/api/notifications` | List channels |
| POST | `/api/notifications` | Create a channel |
| PUT | `/api/notifications/:id` | Update a channel |
| DELETE | `/api/notifications/:id` | Delete a channel |
| POST | `/api/notifications/:id/test` | Send a test notification |

---

## Status Pages

| Method | Path | Description |
|---|---|---|
| GET | `/api/status-pages` | List status pages |
| POST | `/api/status-pages` | Create a status page |
| PUT | `/api/status-pages/:id` | Update a status page |
| DELETE | `/api/status-pages/:id` | Delete a status page |
| GET | `/api/public/status/:slug` | Public data for a status page |

---

## Incidents

| Method | Path | Description |
|---|---|---|
| GET | `/api/incidents` | List incident reports |
| POST | `/api/incidents` | Create an incident report |
| PUT | `/api/incidents/:id` | Update an incident report |
| POST | `/api/incidents/:id/updates` | Add an update to an incident |
| DELETE | `/api/incidents/:id` | Delete an incident report |

---

## Events (SSE)

`GET /api/events` opens a Server-Sent Events stream that pushes monitor status in real time.

```
Authorization: Bearer <token>
# or
GET /api/events?token=<token>
```

### Events emitted

| Event | Payload | Frequency |
|---|---|---|
| `snapshot` | `Monitor[]` — full list of monitors with current status | On connect, then every 60 s |
| `heartbeat` | `{ ts: number }` — Unix timestamp (ms) | Every 30 s |

> **Note:** Cloudflare Workers free tier may close long-lived connections after ~30 s. The client should reconnect automatically, `EventSource` does this natively, and each reconnect immediately receives a fresh `snapshot`.

---

## Settings

| Method | Path | Description |
|---|---|---|
| GET | `/api/settings` | Get all settings |
| PUT | `/api/settings` | Update settings |
| POST | `/api/settings/rebuild-stats` | Recompute the `daily_stats` rollup from the raw logs |

Available settings keys:

| Key | Default | Description |
|---|---|---|
| `retention_days` | `90` | How long raw `status_logs` rows are kept. Cleanup runs at most once a day. |
| `stats_retention_days` | `400` | How long the per-day rollup is kept. Charts read this, so it can outlive the raw logs. |
| `cache_ttl` | `900` | Seconds a cached aggregate lives in KV. Each key is written at most `86400 / cache_ttl` times a day, so lower values cost more KV writes. Minimum 60. |
| `site_title` | — | Shown in the UI. |
| `locale` | `en` | Notification language. |

`rebuild-stats` is only needed after restoring a backup, or once after upgrading a
database that predates the rollup if the automatic backfill did not finish. It
costs one full scan of `status_logs`.

### Aggregation and freshness

Long-range history (the 90-day chart, and uptime over 7/30/90 days) is read from a
per-day rollup table rather than the raw logs, and is cached in KV when a
namespace is bound. Current up/down state, recent checks and incidents are always
read live, so a cache hit never makes a monitor look healthy when it is not.

Uptime windows of 2 days or less are computed from the raw logs so they remain
precise to the second; longer windows are calendar-day aligned (UTC).

---

## Notification Channel Configuration

Each channel stores its config as a JSON object.
Required fields per type:

| Type | Required fields |
|---|---|
| `discord` | `webhookUrl` |
| `slack` | `webhookUrl` |
| `telegram` | `botToken`, `chatId` |
| `email` | `host`, `port` (default `587`), `user`, `password`, `from`, `to` (comma-separated for multiple recipients) |
| `ntfy` | `url`, `topic` - optional: `token` |
| `pushover` | `token`, `user` |
| `webhook` | `url` - optional: `secret` (sent as `X-Pingflare-Secret` header) |
| `apprise` | `url` (Apprise API base URL), `urls` (notification service URLs) - optional: `token` |

---

## Monitor

### Fields

| Field | Default | Description |
|---|---|---|
| `name` | - | Display name |
| `type` | - | `http` or `heartbeat` |
| `interval` | `60` | Check interval in seconds |
| `active` | `true` | Whether the monitor is enabled |
| `toleranceFailures` | `1` | Consecutive failures before alerting |
| `reminderIntervalHours` | null | Hours between reminder alerts while down |
| `callbacksEnabled` | `false` | Send a notification on every check result |
| `surgeProtectionLimit` | null | Max alerts before pausing for 1 hour |

### HTTP-specific

| Field | Default | Description |
|---|---|---|
| `url` | - | Target URL |
| `method` | `GET` | HTTP method |
| `expectedStatus` | `200` | Expected HTTP status code |
| `timeout` | `30` | Request timeout in seconds |
| `followRedirects` | `true` | Follow HTTP redirects |
| `authType` | `none` | `none`, `basic`, `digest`, or `bearer` |
| `headers` | `{}` | Custom request headers as JSON object |
| `body` | null | Request body for POST/PUT/PATCH |

### Heartbeat-specific

| Field | Default | Description |
|---|---|---|
| `heartbeatInterval` | - | Expected interval between pings in seconds |
| `heartbeatGrace` | `30` | Grace period after deadline before marking down |
| `toleranceMissed` | `1` | Consecutive missed heartbeats before alerting |
