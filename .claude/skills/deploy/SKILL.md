---
name: deploy
description: Use when deploying Pingflare to Cloudflare Workers, running D1 migrations against the remote database, creating or rotating its secrets and KV namespace, or diagnosing a deploy that failed on auth, migrations, or free-tier limits.
---

# Deploying Pingflare

## Overview

Pingflare deploys as one Worker serving both the API and the built SvelteKit
frontend, backed by D1 and an optional KV cache. `npm run deploy` is
`npm run build && wrangler deploy` — it builds the frontend but does **not** run
migrations, so migration ordering is manual and matters.

**Core principle: migrations first, then deploy.** New code assumes the schema it
was written against. Deploying first leaves the Worker querying tables and indexes
that do not exist yet.

## Order of operations

```
1. wrangler whoami            -> confirm auth before anything else
2. confirm the Worker NAME    -> see "Verify the target first"
3. npx tsc --noEmit           -> backend typecheck
4. npm run check -w frontend  -> frontend typecheck
5. db:migrate:remote          -> schema BEFORE code
6. npm run deploy             -> build + wrangler deploy
7. verify                     -> see "Verifying a deploy"
```

## Verify the target first

`wrangler deploy` **creates** a Worker when `name` does not match an existing one.
For this project that is actively harmful: a second Worker binds the same D1, so
two crons run and every check is recorded twice.

`wrangler.toml` has been wrong about this before — it said `pingflare` while the
live Worker was `q-pingflare`. Confirm the deployed name before deploying:

```bash
TOKEN=$(python3 -c "import re,pathlib;print(re.search(r'oauth_token\s*=\s*\"([^\"]+)\"', (pathlib.Path.home()/'Library/Preferences/.wrangler/config/default.toml').read_text()).group(1))")
curl -s "https://api.cloudflare.com/client/v4/accounts/<account-id>/workers/scripts" \
  -H "Authorization: Bearer $TOKEN" | python3 -c "import sys,json;print([s['id'] for s in json.load(sys.stdin)['result']])"
```

Then confirm that Worker is the one bound to this database, and read its live cron:

```bash
B="https://api.cloudflare.com/client/v4/accounts/<account-id>/workers/scripts/<name>"
curl -s "$B/settings"  -H "Authorization: Bearer $TOKEN"   # bindings: DB should be the D1 uuid
curl -s "$B/schedules" -H "Authorization: Bearer $TOKEN"   # the cron actually in effect
```

Never print the token. After deploying, re-list the scripts and confirm no new name
appeared.

## Authentication

`wrangler` uses an OAuth refresh token in
`~/Library/Preferences/.wrangler/config/default.toml` (macOS). It expires.

| Symptom | Fix |
|---|---|
| `Failed to fetch auth token: 400 Bad Request` | Refresh token expired. Re-login. |
| `Not logged in.` | Same. |
| `In a non-interactive environment, it's necessary to set a CLOUDFLARE_API_TOKEN` | Either re-login or export a token. |

**`wrangler login` is interactive — it opens a browser.** An agent cannot complete
it. Ask the user to run it themselves in the Claude Code prompt:

```
! npx wrangler login
```

The `!` prefix runs it in the session so the output lands in the conversation.

Non-interactive alternative (CI, or when a browser is unavailable): create a token
with **Workers Scripts:Edit**, **D1:Edit**, and **Workers KV Storage:Edit** at
<https://dash.cloudflare.com/profile/api-tokens>, then `export CLOUDFLARE_API_TOKEN=...`.
Never write the token into a tracked file.

## Migrations

```bash
npm run db:migrate:remote     # wrangler d1 migrations apply pingflare
npm run db:migrate:local      # same, --local, for the dev DB
```

Migrations live in `drizzle/` and are indexed by `drizzle/meta/_journal.json`.
A hand-written `.sql` file is only applied if it has a matching journal entry —
adding the file alone silently does nothing.

**`database_id` is required.** Without it every remote CLI command fails with
"missing a database_id", even though `wrangler deploy` resolves the binding by
name and works fine. Find the uuid with `wrangler d1 list`.

**Baseline an existing database before the first `apply`.** This project creates
its schema at runtime via `ensureSchema`, so a long-running deployment can have a
full schema and an empty `d1_migrations` table. `migrations apply` then tries
`0000_init.sql` first, which uses bare `CREATE TABLE` and fails with "table
already exists", blocking every later migration. Check and baseline:

```bash
npx wrangler d1 migrations list pingflare --remote          # is 0000 listed as pending?
npx wrangler d1 execute pingflare --remote \
  --command "INSERT INTO d1_migrations (name) VALUES ('0000_init.sql')"
```

Only do this when the tables genuinely already exist. Verify with
`SELECT name FROM sqlite_master WHERE type='table'` first.

Migrations that create an index on a large table, or backfill a rollup, take real
time on the first run. Run them from the CLI, not by letting `ensureSchema` do it
inside a request.

## Secrets

Four are required; the Worker refuses to authenticate without them:

```bash
npx wrangler secret put ADMIN_USER
npx wrangler secret put ADMIN_PASS
npx wrangler secret put JWT_SECRET       # long random string
npx wrangler secret put ENCRYPTION_KEY   # long random string
npx wrangler secret list                 # confirm all four
```

`AUTH_DISABLED = "true"` (a plain `[vars]` entry in `wrangler.toml`, not a secret)
removes the built-in login for origins already behind Cloudflare Access. It makes
the first three optional and leaves every `/api` route open to anyone who reaches
the origin, so confirm Access is actually in front of every hostname the Worker
answers on before setting it:

```bash
curl -sI https://q-pingflare.quannda.workers.dev/api/health | head -3
# 302 -> quannda.cloudflareaccess.com  = protected
# 200                                   = NOT protected, do not enable the flag
```

`wrangler`'s OAuth token has no Zero Trust scope, so `GET /accounts/<id>/access/apps`
returns an empty list whether or not applications exist — the curl above is the
reliable check, not that API. See "Bypassing the login" in the README.

Secrets survive deploys. They are only needed once, or when rotating.
`.dev.vars` covers the same values for `wrangler dev` and is gitignored.

## KV cache (optional)

Without it the cached aggregates read straight from D1 and everything still works.

```bash
npx wrangler kv namespace create pingflare-cache
```

Uncomment the `[[kv_namespaces]]` block in `wrangler.toml` and paste the printed
id. Binding must be `CACHE`.

## Free-tier traps

**`wrangler deploy` overwrites the cron schedule from `wrangler.toml`.** If someone
changed the trigger in the Cloudflare dashboard, deploying silently reverts it.
Reconcile the dashboard change into `wrangler.toml` *before* deploying.

The trigger is the floor on how often any monitor is checked, so it sets the
write rate — roughly 6 rows written per check. At 20 monitors:

| Trigger | Rows written/day | |
|---|---|---|
| `* * * * *` | ~173k | over the 100k/day limit |
| `*/2 * * * *` | ~86k | tightest safe setting |
| `*/5 * * * *` | ~35k | comfortable |

A monitor's own `interval` cannot beat the trigger: with `*/5`, a monitor set to
60s is still checked every 5 minutes.

## Verifying a deploy

```bash
npx wrangler deployments list                    # new version is live
curl -s https://<worker-host>/api/health         # {"ok":true,...}
npx wrangler tail                                # live logs, watch one cron fire
```

Then load the dashboard and confirm a monitor's `lastCheckedAt` advances after one
cron interval. `/api/health` passing only proves the Worker booted — it does not
touch D1.

Check usage at Cloudflare dashboard → Workers & Pages → D1 → pingflare → Usage.
Row counts there lag by a few minutes.

**Prove the new code is live, do not assume it.** Pick a value only the new
version writes and watch it appear. After the rollup work, `last_cleanup_at` in
`settings` was the marker: absent before, set by the first cron on new code.

Time the check against the schedule. With `*/5`, ticks land on epochs divisible by
300; querying 100s after a deploy proves nothing. `timeout` does not exist on
macOS — a `timeout 300 wrangler tail` exits instantly and looks like "no cron
fired". Use `wrangler tail ... &` plus `sleep`, then kill it.

## Common mistakes

| Mistake | Consequence |
|---|---|
| Trusting `name` in `wrangler.toml` | Creates a duplicate Worker on the same D1; two crons, double writes |
| Deploying before migrating | Worker queries missing tables/indexes; 500s until the migration lands |
| `migrations apply` on a runtime-created schema | `0000_init.sql` fails on "table already exists" and blocks everything after it |
| Adding a `.sql` file without a journal entry | Migration never applies, no error |
| Omitting `database_id` | Every remote D1 command fails while `deploy` still works, which hides it |
| Deploying with a stale `wrangler.toml` cron | Silently reverts a dashboard schedule change |
| `wrangler deploy` without `npm run build` | Ships the previous frontend build; use `npm run deploy` |
| Assuming `/api/health` proves the DB works | It does not query D1 |
| Checking for a cron before its next tick is due | Looks like a broken deploy; compute the tick from the schedule |
| `timeout` in a verification command | Not present on macOS; the command exits instantly and the check silently passes |
| Retrying `wrangler login` as an agent | It needs a browser; hand it to the user |

## Rollback

```bash
npx wrangler deployments list
npx wrangler rollback [<version-id>]
```

Rollback reverts **code only**. A migration that already ran stays applied, so
prefer additive migrations that older code tolerates.
