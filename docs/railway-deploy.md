# Railway Deploy

This repo should be deployed to Railway as two services from the same GitHub repo:

- `web`: Next.js app in `apps/web`
- `realtime`: Socket.IO server in `apps/realtime`

Use the repository root as the service root for both services so npm workspaces and the shared `data/` directory are available during build and runtime.

## 1. Create the Railway project

1. Create a new Railway project from the GitHub repo.
2. Add a PostgreSQL service.
3. Add two empty services from the repo:
   - `web`
   - `realtime`

## 2. Configure the realtime service

- Root directory: repo root
- Build command: `npm run build:realtime`
- Start command: `npm run start:realtime`
- Health check path: `/health`

Required variables:

```env
DATABASE_URL=${{Postgres.DATABASE_URL}}
CORS_ORIGIN=https://<your-web-domain>
DICTIONARY_VERSION=v1_100k_words_2026_03
TURN_MS_DEFAULT=15000
COUNTDOWN_SECONDS=5
VECTOR_DIM=300
RECONNECT_GRACE_MS=30000
```

Notes:

- Railway injects `PORT` automatically. Do not hardcode it.
- `DATA_PATH` is optional in this repo. Leave it unset first; the realtime service already resolves the monorepo `data/` directory correctly after build. If you explicitly set it, use `/app/data`.
- After the web service gets a public domain, update `CORS_ORIGIN` to that exact HTTPS origin.

## 3. Configure the web service

- Root directory: repo root
- Build command: `npm run build:web`
- Start command: `npm run start:web`
- Health check path: `/api/health`

Required variables:

```env
DATABASE_URL=${{Postgres.DATABASE_URL}}
NEXT_PUBLIC_REALTIME_URL=https://<your-realtime-domain>
NEXT_PUBLIC_DICTIONARY_VERSION=v1_100k_words_2026_03
```

## 4. Run Prisma migrations

Run this once against the Railway project after PostgreSQL is attached:

```bash
npm run prisma:deploy
```

Use a Railway service shell / deploy command flow so the migration runs with the Railway `DATABASE_URL`.

## 5. Wire the public domains

1. Generate a public domain for `realtime`.
2. Set `NEXT_PUBLIC_REALTIME_URL` in `web` to that HTTPS URL.
3. Generate a public domain for `web`.
4. Set `CORS_ORIGIN` in `realtime` to the final `web` HTTPS URL.
5. Redeploy both services.

## 6. Verify after deploy

Check:

- `GET /health` on `realtime`
- `GET /api/health` on `web`
- room creation
- room join/reconnect
- solo daily start
- leaderboard write/read

If Socket.IO fails in production, the first thing to verify is that:

- `NEXT_PUBLIC_REALTIME_URL` points to the realtime service domain
- `CORS_ORIGIN` exactly matches the web service origin
