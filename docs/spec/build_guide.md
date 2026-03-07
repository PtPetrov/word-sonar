# Contexto-Style Multiplayer Word Game (Turn-Based) — Full Build Guide (Railway Option A)

Date: 2026-02-24
Stack: Next.js (latest) + TypeScript + Socket.IO + Railway Postgres + Railway hosting
Auth: Guest username (no passwords), room codes, turn-based solo/co-op/1v1/3v3/
Dictionary: common English surface-form words (single words only)

---

## 0) Goal & Design Constraints

You are building a web-based Contexto-style game with:

- Contexto-like ranking: a guess returns a _rank_ based on semantic similarity to a hidden target word.
- Modes:
  - Solo
  - Co-op (single team, multiple players)
  - Versus: 1v1, 3v3
- Turn-based in ALL multiplayer modes to prevent spamming.
- Scoreboards (at minimum: Daily Solo + match history).
- Hosting: All services on Railway (no Vercel).

Key constraints:

- Only common English single-word surface forms allowed as guesses.
- No chat (optional “suggestions” queue later, without text chat).
- Real-time via Socket.IO (persistent websockets supported on Railway).
- Best practices: monorepo, shared types, schema validation, deterministic game state, server authority.

---

## 1) High-Level Architecture (Railway)

Railway project contains 3 services:

1. Postgres (Railway managed)
   - stores users, matches, guesses, leaderboards

2. realtime service (Node/TS Socket.IO)
   - authoritative game state, rooms, turns, timers
   - loads vocab + vectors at startup
   - computes rank map once per match

3. web service (Next.js)
   - UI + guest identity creation
   - communicates with realtime over Socket.IO
   - reads scoreboards/match history from Postgres (via API routes or server actions)

Optional later:

- Redis service for persistence of in-flight games across realtime restarts

---

## 2) Repository Structure (Monorepo)

Use a monorepo to share types and avoid duplication.

repo/
apps/
web/ # Next.js app
realtime/ # Socket.IO server
packages/
shared/ # shared types, zod schemas, constants
db/ # Prisma schema + client
data/
vocab_30k_words.txt
targets_10k.txt # optional: curated target subset
vectors.f32 # binary float32 matrix (N x D), normalized
word_index.json # word -> index map

Notes:

- The realtime server must be able to read the data files (bundle or download on build).
- Keep a dictionary_version string (e.g., “v1_100k_words_2026_03”).

---

## 3) Game Mechanics (Final Spec)

### 3.1 Dictionary / Guess Rules

Allowed guess:

- lowercase only
- regex: ^[a-z]+$
- present in vocab_30k_words

Reject if:

- not in dictionary → “Not in dictionary”
- contains non-letters / spaces → “Only one English word”
- duplicated guess in the same match:
  - allowed but mark isDuplicate=true; no “best improvement” status

### 3.2 Target selection

Targets are chosen from a curated subset (recommended):

- targets_10k.txt (clean, fun, no stopwords/profanity)
- This prevents terrible daily words.

### 3.3 Turn-based rules

- Turns alternate TEAM-by-TEAM:
  Team A -> Team B -> Team A -> …
- Within a team, the active player rotates each time the team gets a turn.
- Turn timer: default 15 seconds (configurable per room).
- If timer expires: auto PASS.
- Only the active player can submit guess/pass.
- Win condition: rank == 1 (exact target) ends match immediately.

Solo:

- Always your turn (no timer by default).

Co-op:

- One team; active player rotates among players each turn.

### 3.4 Team “Best Rank”

For each team track:

- teamBestRank = min(rank over all guesses by that team)
- isNewTeamBest = true if current guess improves teamBestRank

---

## 4) “Contexto Logic” (Ranking Algorithm)

Your rank is computed as:

- Each vocab word has a vector embedding (dimension D, e.g. 300).
- Similarity = cosine similarity between guess vector and target vector.
- Rank = position of the guess when all vocab words are sorted by similarity to the target (descending).
  Rank 1 is the target word itself.

### Best practice implementation

Precompute vocab vectors once and normalize them to unit length.

At match start:

1. targetIdx = indexByWord[targetWord]
2. scores[i] = dot(M[targetIdx], M[i]) for all i in vocab
3. order = argsort(scores descending)
4. rankByIndex[i] = rank (1..N)

Then for each guess:

- idx = indexByWord[guess]
- rank = rankByIndex[idx]

Important:

- Compute the rank map ONCE per match (not per guess).
- With 30k words this is fast and predictable.

---

## 5) Data Pipeline (Dictionary + Vectors)

### 5.0 Where the “dictionary” comes from (sources)

You need two things:

1. A modern frequency source to define “common words”
2. A vector source that covers those common surface forms

Recommended sources (pick ONE primary approach for v1):

A) **wordfreq (Python library)**

- Designed to surface common words; it’s explicitly aimed at listing words that occur at least once per million words.
- Use its frequencies to select the top candidates, filter to lowercase `^[a-z]+$`, and keep the top common words that exist in the vector set.

B) **Pre-made frequency lists (good for bootstrapping)**

- A GitHub repo based on Peter Norvig’s frequency compilation provides a “top 30,000 common English words” list.
- You can use this as a starting list, then dedupe/filter it to get a clean common-word vocabulary.

Best practice:

- Keep a `dictionary_version` string and store it on every match so ranks are consistent across deployments.
- Separate “allowed guesses” (common words) from “targets” (a curated subset that excludes stopwords/profanity).

### 5.1 Vocabulary creation (common words)

Goal: common, single-word surface forms.

Approach:

- Start from a modern English frequency list (top words).
- Keep only lowercase a-z words.
- Deduplicate, keep the top common words by frequency.
- Exclude profanity from targets (required).

Outputs:

- data/vocab_30k_words.txt (one word per line)
- data/targets_10k.txt (subset for target selection)

### 5.2 Vector generation

Recommended: fastText-style word vectors (distributional, “internet usage” feel).

Outputs (build-time):

- vectors.f32: Float32 binary matrix, shape (N, D), row-major
- word_index.json: { word: index }

Notes:

- Normalize every vector row to unit length for cosine-as-dot.
- If a word lacks a vector, drop it from vocab.
- Runtime binary contract for `vectors.f32`: little-endian `float32`, no header, row-major, shape `N x 300`.

### 5.3 How to Generate `/data` Assets (WSL2 Ubuntu)

Run from the repo root:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install "numpy==1.26.4" "wordfreq==3.1.1" "spacy==3.7.5"
```

Download fastText `wiki-news-300d-1M`:

```bash
mkdir -p /tmp/fasttext
curl -L "https://dl.fbaipublicfiles.com/fasttext/vectors-english/wiki-news-300d-1M.vec.zip" -o /tmp/fasttext/wiki-news-300d-1M.vec.zip
unzip -o /tmp/fasttext/wiki-news-300d-1M.vec.zip -d /tmp/fasttext
```

Build pipeline output:

```bash
python scripts/build_dictionary.py \
  --fasttext_vec /tmp/fasttext/wiki-news-300d-1M.vec \
  --out_dir data \
  --vocab_size 100000 \
  --targets_size 10000 \
  --profanity_file scripts/profanity/en.txt \
  --timezone Europe/Sofia
```

Verify results:

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
print("vocab", len(vocab), "targets", len(targets), "mapping", len(mapping), "rows", raw.size // 300)
PY
```

Recommendation:

- Track `data/vectors.f32` with Git LFS.

---

## 6) Realtime Protocol (Socket.IO Events)

All payloads should be validated with Zod in packages/shared.

Client -> Server:

- room:join { roomCode, user: { id, displayName } }
- room:leave {}
- room:ready { ready: boolean }
- game:start {} (host only)
- turn:guess { word: string }
- turn:pass {}

Server -> Client:

- room:state { roomCode, hostId, status, players, teams }
- game:started { matchId, mode, turnMs, dictionaryVersion }
- turn:state { activeTeamId, activePlayerId, turnNumber, endsAt }
- guess:result { word, rank, byUserId, teamId, isDuplicate, isNewTeamBest, teamBestRank }
- game:won { winnerTeamId, winningWord, turns, durationMs }
- error { code, message }

Room status:

- lobby | in_game | finished

---

## 7) Database (Railway Postgres) — Schema

Use Prisma for migrations + client.

### 7.1 Tables

users

- id (uuid pk)
- display_name (text)
- created_at (timestamp)

rooms (optional; can be ephemeral, but useful for analytics)

- code (text pk)
- created_at
- created_by_user_id
- status

matches

- id (uuid pk)
- mode (enum: solo|coop|1v1|3v3)
- dictionary_version (text)
- target_word (text)
- turn_ms (int)
- started_at (timestamp)
- ended_at (timestamp nullable)
- winner_team_id (text nullable)
- status (enum: active, finished, aborted)

match_players

- match_id (uuid fk)
- user_id (uuid fk)
- team_id (text)
- is_host (bool)
- joined_at (timestamp)

guesses

- id (uuid pk)
- match_id (uuid fk)
- turn_number (int)
- user_id (uuid fk)
- team_id (text)
- word (text)
- rank (int)
- created_at (timestamp)

leaderboard_daily_solo

- date (date)
- user_id (uuid fk)
- turns_to_solve (int)
- time_ms (int)
  Primary key: (date, user_id)

### 7.2 Indices

- guesses(match_id, created_at)
- matches(started_at)
- leaderboard_daily_solo(date, turns_to_solve)

---

## 8) Guest Identity (Best Practice)

No login. Use a stable guest id stored client-side.

On first visit:

- generate uuid v4
- store in localStorage + cookie
- prompt displayName (validate length 2..20, allowed chars)
- create user row in DB on-demand

Security:

- Treat userId as a client hint; server should accept it but can rate-limit abuse.
- Optionally sign the guest id with an HMAC token (later) to reduce spoofing.

---

## 9) Matchmaking / Rooms

MVP:

- Private rooms via short room codes (e.g., 6 chars).
- Host creates room.
- Players join via code.
- Host selects mode: coop / 1v1 / 3v3.
- Teams are created manually via the “versus lobby” flow (see section 20).

---

## 10) Game State (Authoritative Server)

The realtime service holds an in-memory state per room:
RoomState:

- roomCode
- status
- players: { id, displayName, socketId, teamId, ready, connected }
- mode
- turnMs
- activeTeamId
- activePlayerId
- rotation pointers per team
- turnNumber
- endsAt timestamp
- matchId (when started)
- targetWord (server-only until end)
- rankByIndex (Int32Array) OR rankByWord Map
- guessedSet (Set<string>)
- teamBestRank: { A: number, B: number }
- startTime

Best practice:

- Keep the server as the only source of truth.
- Clients render whatever the server emits.
- On reconnect, send full room:state + turn:state + recent guess history.

Timers:

- Use a single interval tick or per-room timeout.
- On timeout: auto PASS and advance turn.

---

## 11) Web App (Next.js) Pages

MVP routes:

- / (home)
- /solo (solo play)
- /room (create/join)
- /room/[code] (lobby + game)
- /leaderboard (daily solo)

UI components:

- GuessInput (disabled if not your turn)
- GuessHistory list
- TeamBestRank banner
- TurnIndicator + countdown
- PlayerList

---

## 12) Rate Limiting & Abuse Prevention

Turn-based already limits spam, but add:

- server-side validation of turn ownership
- max room size per mode
- room code brute-force protection (basic: per-IP join attempt rate)
- profanity filter on display names

---

## 13) Deployment on Railway (Step-by-Step)

### 13.1 Create Railway project

- Create new project
- Add Postgres plugin
- Create realtime service from repo
- Create web service from repo

### 13.2 Environment variables

Postgres:

- Railway provides DATABASE_URL

realtime service env:

- DATABASE_URL
- PORT (Railway provides)
- CORS_ORIGIN (web service URL)
- DICTIONARY_VERSION
- TURN_MS_DEFAULT=15000
- DATA_PATH=/app/data (example)

web service env:

- DATABASE_URL
- NEXT_PUBLIC_REALTIME_URL=https://<realtime-service-url>
- NEXT_PUBLIC_DICTIONARY_VERSION

### 13.3 Networking

- Ensure realtime service allows websocket traffic.
- Configure CORS in Socket.IO to allow the web domain.

---

## 14) Implementation Plan (Exact Order)

Phase 0 — scaffolding

1. Create monorepo workspace
2. Add shared package with Zod schemas + types
3. Add db package with Prisma schema + migrations

Phase 1 — realtime skeleton 4) Build realtime server:

- Express/HTTP server + Socket.IO
- versus lobby map
- join/leave + room:state broadcast

Phase 2 — dictionary engine 5) Implement engine module:

- load vocab + vectors
- build index map
- startMatch(): choose target, build rankByIndex
- getRank(word): validate + lookup

Phase 3 — turn system 6) Implement:

- team assignment via manual lobby flow
- turn rotation
- timer + auto pass
- emit turn:state

Phase 4 — guesses + win 7) turn:guess handler:

- validate active player
- validate word
- detect duplicates
- compute rank
- update teamBestRank
- persist guess to DB
- emit guess:result
- if rank==1 -> finalize match, emit game:won, persist match

Phase 5 — Next.js UI 8) Implement web UI:

- create guest identity
- connect to Socket.IO
- lobby + team creation/join
- in-game UI rendering events
- solo mode (reuse realtime engine, or local-only; best is reuse realtime)

Phase 6 — leaderboard 9) Implement daily solo:

- store daily seed target (same target for everyone that day)
- compute turns + time, write to leaderboard_daily_solo
- Next.js leaderboard page: query and display

Daily timezone: Europe/Sofia.

---

## 15) Best Practices Checklist

- Validate all Socket.IO payloads with Zod (server + client).
- Never trust client: server checks turn ownership, room membership, dictionary.
- Keep dictionary_version pinned and stored per match.
- Use deterministic target selection for daily mode (seeded by date in Europe/Sofia).
- Keep target secret until game over (only reveal in game:won).
- Keep vectors in memory for speed; 30k is small enough.
- Write unit tests for:
  - guess validation
  - turn rotation logic
  - rank lookup behavior
  - match end conditions

---

## 16) What You Need Prepared Before Coding

1. Confirm game constants:

- TURN_MS (15s recommended)
- Room code length (6)
- Max players (coop: 8, 3v3: 6)
- Dictionary version string

2. Provide data files:

- vocab_30k_words.txt
- targets_10k.txt (exclude profanity)
- vectors.f32
- word_index.json

3. Decide daily mode policy:

- daily solo target from targets_10k
- timezone: Europe/Sofia

---

## 17) Optional Enhancements (Later)

- Redis for resilient room state
- Suggestions queue (no chat): teammates can “suggest” words from history
- Ranked MMR using Elo/Glicko for 1v1 and team modes
- Anti-cheat token for guest id (HMAC)
- Reconnect resume with full state sync

---

## 18) Codex-Ready Implementation Details (Copy/Paste Guide)

This section is intentionally explicit so Codex can generate the repo end-to-end.

### 18.1 Node version

Use Node 20 LTS on Railway (set in package.json engines and Railway settings).

### 18.2 Monorepo tooling

Use npm workspaces.

### 18.3 Repo initialization commands

From an empty folder:

- git init
- npm init -y
- mkdir -p apps/web apps/realtime packages/shared packages/db data docs/spec

Root package.json must include:

- "private": true
- "workspaces": ["apps/*", "packages/*"]
- "engines": { "node": ">=20" }

### 18.4 Root scripts

- "dev": run web + realtime concurrently
- "lint": workspace lint
- "build": workspace build

### 18.5 packages/shared (types + zod schemas)

Create:

- packages/shared/src/schemas.ts
- packages/shared/src/constants.ts
- packages/shared/src/index.ts

Best practice:

- Validate on BOTH server and client.

### 18.6 packages/db (Prisma)

- Prisma schema and migrations.
- Prisma client singleton export.

### 18.7 apps/realtime responsibilities

- create/join/leave versus lobbies
- manual team creation (A/B captains)
- auto-start when full
- compute rank map once per match
- authoritative turns/timers
- persist Match + Guess rows

### 18.8 apps/web responsibilities

- guest identity capture (id + displayName)
- create/join flow with minimal clicks
- show invite links
- show turn-based game UI
- leaderboard page

### 18.9 Daily Solo mode

Daily target selection must be deterministic by date in Europe/Sofia.

---

## 19) Final MVP Acceptance Criteria

Lobby:

- Captain can create a lobby code and others can join.
- Guest name flow works.
- 1v1 and 3v3 modes work.

Game:

- Turn indicator shows correct active player + countdown.
- Only active player can guess.
- Guess returns rank and shows in history.
- Team best rank updates.
- Win on rank 1 ends match and reveals the target.
- Match and guesses persist in Postgres.

Solo Daily:

- Same daily target for all users (Europe/Sofia date).
- Completing solo writes leaderboard row.
- Leaderboard page shows top results.

---

## 20) Manual Team Creation (Fast “Team vs Team” Flow)

You want the least-click, least-wait flow where two teams form independently, then immediately play each other in the same match instance.

### 20.1 UX goals

- Team captain creates a team in 1 click.
- Invites are via shareable link/code (no typing user IDs).
- Joining a team is 1 click.
- As soon as BOTH teams are “full” (or meet minimum), the game can start automatically (or with a single captain click).
- No “waiting room” complexity beyond “Team A ready / Team B ready”.

### 20.2 Entities

- Team = temporary lobby group (not a long-lived clan)
- Match Lobby = a “versus lobby” that contains exactly 2 teams (A and B)

We will implement:

- **Team Lobby**: captain + invited teammates
- **Versus Lobby**: Team A lobby + Team B lobby joined together

### 20.3 The simplest possible flow (recommended)

#### Step A: Create a Versus Lobby (captain A)

- Captain clicks “Play Team vs Team”
- App generates a **versusCode** (6 chars) and auto-creates **Team A**
- Captain sees:
  - “Invite your teammates” (teamJoinLink)
  - “Invite the other team captain” (versusJoinLink)
- Two copy buttons (no extra screens)

#### Step B: Team A fills

- Teammates open teamJoinLink → auto-join Team A in that versus lobby
- No extra clicks beyond entering a display name (if not set)

#### Step C: Team B created by captain B (via link)

- Other captain opens versusJoinLink
- One click: “Create Team B”
- Captain B sees “Invite your teammates” (teamBJoinLink)

#### Step D: Team B fills

- Teammates join via teamBJoinLink

#### Step E: Start automatically

- When Team A size == requiredTeamSize AND Team B size == requiredTeamSize:
  - Auto-start countdown (3 seconds) then start match

This keeps clicks minimal and avoids “ready toggles” entirely.

### 20.4 Room codes & links

Use ONE versusCode, and derive team links from it:

- versusJoinLink: /room/{versusCode}
- teamAJoinLink: /room/{versusCode}?team=A
- teamBJoinLink: /room/{versusCode}?team=B

Rules:

- If you open /room/{versusCode} with no team param:
  - If Team B doesn’t exist yet, show “Create Team B” button (for captain B)
  - If both teams exist, show a “spectator” view (optional) or prompt to join a team

### 20.5 Team size options

For MVP: only 3v3 team-vs-team.

- requiredTeamSize = 3
- mode = "3v3"

### 20.6 Server state changes (authoritative)

Server stores for each versusCode:

- Team A: captainId, playerIds[]
- Team B: captainId, playerIds[]
- requiredTeamSize
- status: forming | countdown | in_game | finished

Auto-start condition:

- len(teamA.players) == requiredTeamSize AND len(teamB.players) == requiredTeamSize
- status == forming
  Then:
- status = countdown
- emit room:state + countdown event
- after 3s: start match

### 20.7 Updated Socket.IO events for team flow

Add the following (in addition to the earlier contract):

Client -> Server:

- lobby:createVersus { mode: "3v3" } # returns versusCode
- lobby:joinVersus { versusCode } # join lobby, no team yet
- lobby:createTeam { versusCode, teamId: "A" | "B" } # assigns captain
- lobby:joinTeam { versusCode, teamId: "A" | "B" } # adds player to team
- lobby:leaveVersus { versusCode }

Server -> Client:

- lobby:created { versusCode, mode, requiredTeamSize }
- lobby:countdown { versusCode, startsAt }
- lobby:error { code, message }

Important:

- room:state must include teams + captains + fullness.

### 20.8 “Less waiting time” best practices

- Remove ready toggles for team-vs-team; fullness implies readiness.
- Auto-start when full (best).
- If a player drops:
  - if in forming/countdown: stop countdown, revert to forming
  - if in_game: allow reconnect grace (e.g., 30s) then forfeit after missed turns (later).

---

## 21) Full Prisma Schema (Codex-ready)

Paste this as your starting prisma/schema.prisma (adjust provider/env names as needed):

```prisma
// packages/db/prisma/schema.prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

enum MatchMode {
  solo
  coop
  v1
  v3
}

enum MatchStatus {
  active
  finished
  aborted
}

model User {
  id          String   @id @default(uuid())
  displayName String
  createdAt   DateTime @default(now())

  matchPlayers MatchPlayer[]
  guesses      Guess[]
  soloDaily    LeaderboardDailySolo[]
}

model Match {
  id               String      @id @default(uuid())
  mode             MatchMode
  status           MatchStatus @default(active)
  dictionaryVersion String
  targetWord       String
  turnMs           Int
  startedAt        DateTime    @default(now())
  endedAt          DateTime?
  winnerTeamId     String?

  players          MatchPlayer[]
  guesses          Guess[]

  @@index([startedAt])
}

model MatchPlayer {
  matchId   String
  userId    String
  teamId    String
  isHost    Boolean @default(false)
  joinedAt  DateTime @default(now())

  match     Match @relation(fields: [matchId], references: [id], onDelete: Cascade)
  user      User  @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@id([matchId, userId])
  @@index([matchId])
  @@index([userId])
}

model Guess {
  id         String   @id @default(uuid())
  matchId    String
  turnNumber Int
  userId     String
  teamId     String
  word       String
  rank       Int
  createdAt  DateTime @default(now())

  match      Match @relation(fields: [matchId], references: [id], onDelete: Cascade)
  user       User  @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([matchId, createdAt])
  @@index([userId, createdAt])
}

model LeaderboardDailySolo {
  date        DateTime
  userId      String
  turnsToSolve Int
  timeMs      Int

  user        User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@id([date, userId])
  @@index([date, turnsToSolve, timeMs])
}
```

Notes:

We use v1/v3 naming in enums to avoid starting identifiers with digits.

In app code, map:

"1v1" -> MatchMode.v1

"3v3" -> MatchMode.v3

22. Full File List (Codex-ready)

This is the exact file list Codex should produce (MVP). Each file includes a short responsibility note.

22.1 Root

package.json (workspaces + scripts)

tsconfig.base.json (shared TS config)

.gitignore

README.md (how to run locally + deploy)

docs/skills.md

docs/spec/build_guide.md

data/

vocab_30k_words.txt

targets_10k.txt

vectors.f32

word_index.json

22.2 packages/shared

packages/shared/package.json

packages/shared/tsconfig.json

packages/shared/src/constants.ts

packages/shared/src/schemas.ts

packages/shared/src/types.ts

packages/shared/src/index.ts

Schemas to include (minimum):

lobby:createVersus

lobby:created

lobby:joinVersus

lobby:createTeam

lobby:joinTeam

room:state (must include teams/captains/fullness)

game:started

turn:state

turn:guess

turn:pass

guess:result

game:won

error

22.3 packages/db

packages/db/package.json

packages/db/prisma/schema.prisma

packages/db/src/client.ts (Prisma singleton export)

packages/db/src/index.ts

22.4 apps/realtime

apps/realtime/package.json

apps/realtime/tsconfig.json

apps/realtime/src/index.ts

apps/realtime/src/config.ts

apps/realtime/src/db.ts

apps/realtime/src/state/versusLobbies.ts

apps/realtime/src/engine/dictionary.ts

apps/realtime/src/engine/vectors.ts

apps/realtime/src/engine/ranking.ts

apps/realtime/src/game/turns.ts

apps/realtime/src/game/handlers.ts

apps/realtime/src/utils/roomCode.ts

apps/realtime/src/utils/hash.ts

apps/realtime/src/utils/time.ts

apps/realtime/src/utils/log.ts

Minimum behavior Codex must implement:

lobby:createVersus -> create lobby + Team A captain

lobby:joinVersus -> join lobby (no team)

lobby:createTeam -> create Team B + captain

lobby:joinTeam -> join A or B

auto-start countdown when both teams are full

turn:guess and turn:pass with validation

persist matches + guesses to Postgres

22.5 apps/web

apps/web/package.json

apps/web/next.config.ts

apps/web/tsconfig.json

apps/web/app/layout.tsx

apps/web/app/page.tsx (Home)

apps/web/app/solo/page.tsx

apps/web/app/room/page.tsx (Create vs Join)

apps/web/app/room/[code]/page.tsx (Versus lobby + game)

apps/web/app/leaderboard/page.tsx

apps/web/app/api/leaderboard/route.ts (GET)

apps/web/app/api/user/route.ts (POST create guest user, optional)

apps/web/src/lib/socket.ts

apps/web/src/lib/guest.ts

apps/web/src/components/NameModal.tsx

apps/web/src/components/VersusCreateCard.tsx

apps/web/src/components/VersusJoinCard.tsx

apps/web/src/components/TeamPanel.tsx

apps/web/src/components/GameBoard.tsx

apps/web/src/components/GuessHistory.tsx

apps/web/src/components/TurnBanner.tsx

apps/web/src/components/Countdown.tsx

UX requirement (“less clicks”):

Home has a single CTA: “Team vs Team (3v3)” which:

creates lobby

shows two share buttons: “Invite teammates” and “Invite other captain”

When captain B opens the link:

one click “Create Team B”

then share “Invite teammates”

23. Updated MVP Acceptance Criteria (Team vs Team)

Team flow:

Captain A creates versus lobby in 1 click and becomes Team A captain.

Team A link allows 2 teammates to join in 1 click each.

Captain B link allows captain to create Team B in 1 click.

Team B link allows 2 teammates to join in 1 click each.

When both teams reach 3 players:

countdown starts automatically

match begins without manual ready toggles

Game runs turn-based team-by-team, rotating players.

Only active player can guess.

Rank responses match dictionary + rankMap logic.

Match and guesses persist.

24. Instructions for Codex (Mandatory)

When generating the implementation and the final step-by-step guide, Codex MUST:

Research and confirm the latest stable documentation and versions of:

Next.js (App Router + installation + production deployment)

Socket.IO (server initialization, CORS, reconnection, client install)

Prisma ORM (PostgreSQL setup, migrations, client usage)

TypeScript (stable release)

Zod (v4)

Railway (Postgres env vars, services, ports, deployments)

Use only stable releases (no canary/beta/rc) unless explicitly requested.

Include a complete, end-to-end, step-by-step guide that covers:

Repo scaffolding (commands)

Exact folder structure + every file created

Full code for all required files (or a precise file-by-file checklist + snippets that are sufficient to compile)

Local dev setup

Railway deployment steps for all services (web + realtime + Postgres)

Environment variables and where to set them

How to run Prisma migrations on Railway

How to connect web -> realtime -> DB

How to validate Socket.IO payloads on both sides

How to handle reconnects and resync state

MVP acceptance testing steps

Prefer primary sources (official docs / npm pages) and align code to those docs.

Official docs / primary references to start from (Codex must verify freshness):

Next.js installation + App Router docs: https://nextjs.org/docs/app/getting-started/installation

Next.js npm package: https://www.npmjs.com/package/next

Socket.IO server installation (v4): https://socket.io/docs/v4/server-installation/

Socket.IO client installation (v4): https://socket.io/docs/v4/client-installation/

Socket.IO npm packages: https://www.npmjs.com/package/socket.io
and https://www.npmjs.com/package/socket.io-client

Prisma ORM docs: https://www.prisma.io/docs

Prisma npm packages: https://www.npmjs.com/package/prisma
and https://www.npmjs.com/package/@prisma/client

TypeScript downloads: https://www.typescriptlang.org/download/

TypeScript npm package: https://www.npmjs.com/package/typescript

Zod docs: https://zod.dev/

Zod npm package: https://www.npmjs.com/package/zod

Railway Postgres docs (env vars including DATABASE_URL): https://docs.railway.com/databases/postgresql

Codex MUST keep the product requirements from this document unchanged unless asked:

English-only, 30k surface-form single words

Contexto-style rank logic (rank among vocabulary by similarity)

Manual team creation flow (Team A + Team B) with minimal clicks

3v3 team-vs-team (no 5v5)

Turn-based gameplay in multiplayer

Guest usernames only (no login)

No chat

END.
