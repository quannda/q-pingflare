# Local Development

### 1. Dependencies

```bash
npm install
```

### 2. Secrets

```bash
cp .dev.vars.example .dev.vars
```

### 3. Apply database migrations

```bash
npm run db:migrate:local
```

### 4. Start

```bash
npm run dev
```

Starts backend (port 8787), frontend (port 5173) and cron simulator together.

Or start each individually:

```bash
npm run dev:backend
npm run dev:frontend
npm run dev:cron
```

#### Cron simulator

`dev:cron` hits `http://localhost:8787/__scheduled?cron=*+*+*+*+*` every 60 seconds. Production uses the `*/5 * * * *` trigger from `wrangler.toml` to stay inside the D1 free-tier write budget; locally the faster tick just gives quicker feedback.

To trigger the cron manually:

```bash
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```
