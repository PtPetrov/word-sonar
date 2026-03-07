# Word Sonar (Contexto-Style Multiplayer)

Monorepo with:
- `apps/web`: Next.js App Router UI
- `apps/realtime`: authoritative Socket.IO server
- `packages/shared`: shared Zod event contracts/types/constants
- `packages/db`: Prisma schema + client
- `data/`: vocab/targets/vectors assets

## What Is Already Done

- Event-contract-first shared schemas/types/constants for Socket.IO are implemented.
- Prisma schema + initial migration + Prisma client singleton are implemented.
- Realtime server state machine is implemented:
  - manual team creation (captain A / captain B)
  - auto-start countdown
  - team turn rotation + turn timers + pass/guess guards
  - guess validation (`^[a-z]+$`, dictionary membership)
  - rank map computed once per match
  - DB persistence for rooms/matches/guesses/daily solo leaderboard
- Web UI flow is implemented:
  - guest name modal
  - create/join room flows
  - solo and leaderboard pages
  - solo context clues, hint flow, and target reveal controls
  - socket client and in-room gameplay UI
- Build, typecheck, lint pass in this environment.

## Prerequisites

- Node.js 22+
- npm 10+
- PostgreSQL (local) OR Railway Postgres

## Scaffolding Commands (Already Applied Here)

```bash
mkdir -p apps/web apps/realtime packages/shared packages/db data docs/spec
npm init -y
```

Then workspace package manifests, tsconfig, Prisma schema/migrations, and app code were added.

## Install Dependencies

```bash
npm_config_cache=/tmp/.npm npm install --workspaces --include-workspace-root
```

## Environment Variables

Create root `.env`:

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/word_hunt"
PORT=4001
CORS_ORIGIN="http://localhost:3000"
DICTIONARY_VERSION="v1_100k_words_2026_03"
TURN_MS_DEFAULT=15000
COUNTDOWN_SECONDS=5
DATA_PATH="/home/ptp/projects/word-hunt/data"
VECTOR_DIM=300
RECONNECT_GRACE_MS=30000
NEXT_PUBLIC_REALTIME_URL="http://localhost:4001"
NEXT_PUBLIC_DICTIONARY_VERSION="v1_100k_words_2026_03"
```

Create `apps/realtime/.env` (or reuse root vars):

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/word_hunt"
PORT=4001
CORS_ORIGIN="http://localhost:3000"
DICTIONARY_VERSION="v1_100k_words_2026_03"
TURN_MS_DEFAULT=15000
COUNTDOWN_SECONDS=5
DATA_PATH="../../data"
VECTOR_DIM=300
RECONNECT_GRACE_MS=30000
```

## Dictionary Asset Pipeline (WSL2 Ubuntu)

The realtime server expects the following files in `data/`:
- `vocab_100k_words.txt` (100,000 words; runtime also accepts `vocab_30k_words.txt` fallback)
- `targets_10k.txt` (10,000 words)
- `word_index.json` (`word -> index`)
- `vectors.f32` (little-endian `float32`, row-major, `N x 300`, row-normalized)

Use this build flow:

```bash
cd /home/ptp/projects/word-hunt
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install "numpy==1.26.4" "wordfreq==3.1.1" "spacy==3.7.5"
```

Download and unpack fastText vectors:

```bash
mkdir -p /tmp/fasttext
curl -L "https://dl.fbaipublicfiles.com/fasttext/vectors-english/wiki-news-300d-1M.vec.zip" -o /tmp/fasttext/wiki-news-300d-1M.vec.zip
unzip -o /tmp/fasttext/wiki-news-300d-1M.vec.zip -d /tmp/fasttext
```

Run the pipeline:

```bash
python scripts/build_dictionary.py \
  --fasttext_vec /tmp/fasttext/wiki-news-300d-1M.vec \
  --out_dir data \
  --vocab_size 100000 \
  --targets_size 10000 \
  --profanity_file scripts/profanity/en.txt \
  --timezone Europe/Sofia
```

Quick verification:

```bash
wc -l data/vocab_100k_words.txt data/targets_10k.txt
python - <<'PY'
from pathlib import Path
import json
import numpy as np
vocab = [line.strip() for line in Path("data/vocab_100k_words.txt").read_text().splitlines() if line.strip()]
targets = [line.strip() for line in Path("data/targets_10k.txt").read_text().splitlines() if line.strip()]
mapping = json.loads(Path("data/word_index.json").read_text())
raw = np.fromfile("data/vectors.f32", dtype="<f4")
print("vocab", len(vocab), "targets", len(targets), "mapping", len(mapping), "vectors_shape", (raw.size // 300, 300))
PY
```

For repo storage, track binary vectors with Git LFS:

```bash
git lfs install
git lfs track "data/vectors.f32"
```

### Profanity List Source

`scripts/profanity/en.txt` is a minimal starter so local builds work immediately. Replace or extend it before production runs using a maintained open-source profanity list (for example, LDNOOBW or other curated datasets), then keep one lowercase token per line.

Create `apps/web/.env.local`:

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/word_hunt"
NEXT_PUBLIC_REALTIME_URL="http://localhost:4001"
NEXT_PUBLIC_DICTIONARY_VERSION="v1_100k_words_2026_03"
```

## Prisma Migration

1) Generate client:

```bash
npm run prisma:generate
```

2) Local DB migration:

```bash
npm run prisma:deploy
```

If this fails with `localhost:5432` connection error, start Postgres first or switch `DATABASE_URL` to Railway.

## Run Locally

```bash
npm run dev
```

- Web: `http://localhost:3000`
- Realtime health: `http://localhost:4001/health`

## Multi-Tab 3v3 Test

1) Open tab A at `/room?create=3v3`; set guest name; captain A room is created.
2) Copy Team A link, open two more tabs (A2, A3), join Team A.
3) Open base room link in a new tab (B captain), click **Create Team B**.
4) Copy Team B link, open two more tabs (B2, B3), join Team B.
5) Confirm auto-countdown starts when both teams are full.
6) Confirm only active player can guess/pass and turns rotate team-by-team.
7) Win by guessing exact target (`rank #1`) and verify game end event.

## Railway Deployment (Web + Realtime + Postgres)

1) Create Railway project.
2) Add **Postgres** service.
3) Add **realtime** service from repo:
   - Root directory: `apps/realtime` (or monorepo root with proper build/start commands)
   - Build command: `npm run build --workspace=@word-hunt/realtime`
   - Start command: `npm run start --workspace=@word-hunt/realtime`
4) Add **web** service from repo:
   - Build command: `npm run build --workspace=@word-hunt/web`
   - Start command: `npm run start --workspace=@word-hunt/web`
5) Set env vars on both services:
   - `DATABASE_URL` from Railway Postgres
   - `NEXT_PUBLIC_REALTIME_URL` on web = realtime public URL
   - realtime vars: `PORT`, `CORS_ORIGIN`, `DATA_PATH`, `VECTOR_DIM`, `DICTIONARY_VERSION`, timers
6) Run migrations against Railway DB:

```bash
DATABASE_URL="<railway postgres url>" npm run prisma:deploy
```

7) Deploy both services.
8) Verify websocket connectivity in browser devtools:
   - `wss://<realtime-domain>/socket.io/...`

## Smoke Test Checklist

- Home page shows: Team vs Team + Daily Solo actions.
- Guest name modal appears for first-time session.
- 1v1 and 3v3 lobby creation works.
- Team B creation is one click from base room link.
- Auto-start only when both teams are full.
- Countdown cancels if player leaves before start.
- In-game turn guard blocks non-active users.
- Guess validation rejects invalid format/non-dictionary words.
- Rank improves team best correctly; duplicates are flagged.
- Match persists guesses and final winner.
- Solo daily seed uses `Europe/Sofia` date and writes leaderboard entry.
- Leaderboard API/page return same-day sorted entries.

## MVP Acceptance Check

Current implementation satisfies:
- English-only single-word guesses (`^[a-z]+$`)
- profanity excluded from targets
- solo/coop/1v1/3v3 modes
- manual team creation + auto-start
- no chat
- daily solo seed by Europe/Sofia date

Only remaining operational dependency in this environment:
- Active PostgreSQL connection for `prisma migrate deploy`.
