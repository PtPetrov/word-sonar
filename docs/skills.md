# skills.md

This repository uses an AI-assisted workflow. This file defines the “skills” (repeatable workflows) the assistant should follow when working in this codebase, aligned to our stack and conventions for the **Contexto-style multiplayer word game**.

---

## Tech stack (source of truth)

### Web + Realtime (single product)

- **Next.js 16+** (App Router), React 19
- **TypeScript** (strict), ESLint + Prettier
- **Realtime:** Socket.IO (server + client)
- **DB:** Postgres (Railway Postgres)
- **ORM:** Prisma
- **Deploy:** Railway (web + realtime services + Postgres)
- Auth: **Guest usernames** (no passwords/OAuth for MVP)

### Game/ML assets

- Dictionary: **common English surface-form words**, single-token words only
- Ranking: **Contexto-style** semantic similarity → **rank among vocabulary**
- Assets shipped with repo for MVP:
  - `data/vocab_30k_words.txt`
  - `data/targets_10k.txt` (curated target subset)
  - `data/vectors.f32` (Float32 matrix, normalized)
  - `data/word_index.json` (word → index)

### Documentation files (must be used together)

- **Operating rules:** `/docs/skills.md` (this file)
- **Product spec + build plan:** `/docs/spec/contexto_multiplayer_build_guide.md`  
  (converted from the guide you prepared)

---

## Project invariants (MUST NOT CHANGE)

These are non-negotiable product requirements unless the user explicitly changes them.

- **Modes:** Solo, Co-op, **1v1**, **3v3** (no 5v5)
- **Manual teams (minimal clicks):**
  - Captain A creates a **versus lobby** and becomes **Team A captain**
  - Captain A invites 2 teammates (Team A link)
  - Captain B opens the versus link, clicks **Create Team B** (1 click), invites 2 teammates (Team B link)
  - **Auto-start** when both teams have 3 players (short countdown)
- **Turn-based multiplayer always**
  - Team-by-team turns, rotate active player inside each team
  - Turn timer (default 15s); timeout = PASS
- **No chat**
- **Guest username only** (no passwords/OAuth for MVP)
- **Dictionary rules:** English-only, surface-form, single word `^[a-z]+$`
- **Ranking logic:** compute **rankMap once per match**, never per-guess

---

## Global operating rules

1. **Be deterministic**: don’t invent routes, events, file paths, env vars, or DB tables. Search the repo first.
2. **Event-contract first**: update `packages/shared` Zod schemas/types before changing server or client logic.
3. **Server is authoritative**: turn order, timers, validation, rank lookup, match results enforced on realtime server.
4. **Minimal diff**: small safe changes; avoid refactoring unrelated code.
5. **Type-safety first**: no `any` unless isolated and justified.
6. **Validate everything**: validate all Socket.IO payloads with Zod (server + client).
7. **Performance**: compute ranking once per match; avoid expensive per-message work.
8. **Security**: never trust client turn claims; sanitize display names; never log secrets.
9. **Docs stay in sync**: if behavior changes, update `/docs/spec/...` and/or README.

---

## Repo discovery skill

**Goal:** understand the codebase quickly before changing anything.

Checklist:

- Identify package manager: `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock`
- Scan:
  - `README.md`
  - root `package.json` scripts (workspaces)
  - `apps/web` (Next App Router structure)
  - `apps/realtime` (Socket.IO server)
  - `packages/shared` (Zod schemas + shared constants)
  - `packages/db/prisma/schema.prisma` (models + migrations)
  - `data/` (dictionary + vectors)
  - `.env.example` (if present)

Useful commands (adjust to package manager):

- Install: `npm i`
- Dev: `npm run dev`
- Lint: `npm run lint`
- Build: `npm run build`
- Prisma: `npx prisma generate`, `npx prisma migrate dev`

Deliverable:

- A short summary of relevant files + safest place to implement the change.

---

## State machine skill (realtime correctness)

**Use when:** implementing/altering lobby flow, start conditions, turns, reconnects.

### Canonical states

- `forming` → `countdown` → `in_game` → `finished`
- Optional: `aborted` (if room collapses mid-game)

### Allowed actions per state

- `forming`
  - create/join lobby
  - create/join team
  - leave
  - (no guesses)
- `countdown`
  - leave (may revert to forming if a team becomes not-full)
  - no team changes unless you explicitly support it
- `in_game`
  - only active player can guess/pass
  - disconnect triggers reconnect grace
- `finished`
  - show results, allow “rematch” flow (optional later)

### Reconnect & resync rules

- On reconnect, server must emit:
  - `room:state` (full snapshot)
  - `turn:state` (active player + endsAt)
  - recent guess history (or last N) so client UI can rebuild

Deliverables:

- State transition table
- Guards in handlers (reject invalid transitions)
- Reconnect behavior described + tested

---

## Event contract skill (Zod-first, shared types)

**Use when:** adding/modifying any Socket.IO event or payload.

Rules:

- Every event payload has a Zod schema in `packages/shared/src/schemas.ts`
- Server validates incoming payloads:
  - `safeParse` → emit `error` with code/message on failure
- Client validates server payloads in dev (or always, if preferred)

Deliverables:

- Updated schemas
- Updated inferred TS types
- Updated server/client handlers

---

## Manual Team Creation skill (minimal clicks Team vs Team)

**Use when:** anything involving team formation UX and lobby flow.

Rules:

- **No ready toggles** for Team vs Team. Full team = ready.
- One versusCode drives everything:
  - `/room/{code}` (captain B creates Team B)
  - `/room/{code}?team=A` (team A join link)
  - `/room/{code}?team=B` (team B join link)
- Auto-start when Team A and Team B reach 3 players.
- If someone leaves during countdown and a team is no longer full:
  - cancel countdown → revert to forming

Deliverables:

- UI flow with minimum clicks
- Events implemented:
  - `lobby:createVersus`, `lobby:created`, `lobby:createTeam`, `lobby:joinTeam`, `lobby:countdown`
- Edge cases: captain leaves, teammate leaves, duplicate join

---

## Realtime game feature skill (Socket.IO authoritative server)

**Use when:** adding/altering rooms, turns, timers, guess validation, match persistence.

Approach:

1. Confirm event schemas in `packages/shared`.
2. Implement handlers with guards:
   - membership checks
   - state checks
   - active player checks
3. Timers:
   - one timeout per room
   - clear on turn advance/end
4. Persistence:
   - create `Match` on start
   - write each `Guess`
   - finalize `Match` on win (winnerTeamId, endedAt)

Outputs:

- Files changed/created
- Updated schemas + handler code
- How to test using multiple browser tabs

---

## Contexto ranking engine skill (dictionary + vectors + rankMap)

**Use when:** modifying similarity/rank logic, dictionary constraints, daily target logic, or performance.

Rules:

- Allowed guesses:
  - lowercase `^[a-z]+$`
  - in vocab
- Lemma-only: reject inflections if not in vocab.
- Compute **rankMap once per match**:
  - load vectors into memory at boot
  - on match start: compute dot products to target vector, sort, build `rankByIndex`
- Store `dictionary_version` on every match.

Data handling:

- All assets live in `data/` for MVP.
- Use `DICTIONARY_VERSION` in env and store it in the DB per match.
- On boot: validate files exist + dimensions match expectations; crash fast if not.

Deliverables:

- Engine module changes (`loadDictionary`, `buildRankMap`, `getRank`)
- Performance note (complexity, memory)
- Test cases (invalid word, duplicate, rank=1 win)

---

## Next.js web app implementation skill

**Use when:** building pages, lobby UI, game UI, leaderboard pages, API routes.

Approach:

1. Confirm App Router structure under `apps/web/app`.
2. Data flow:
   - Socket.IO for realtime state (client components)
   - DB access server-side only (API routes / server actions)
3. UI rules:
   - show turn owner + countdown clearly
   - disable guess input unless active player
   - keep lobby “create vs join” to minimal clicks

Output:

- Files to create/change
- Exact code changes
- How to test

---

## Prisma + Postgres data modeling skill

**Use when:** adding models/fields/indexes/migrations.

Rules:

- Small migrations; no unrelated schema changes.
- Index common queries:
  - leaderboard: `(date, turnsToSolve, timeMs)`
  - guesses: `(matchId, createdAt)`
- Use enums for finite states (`MatchMode`, `MatchStatus`).
- Keep naming consistent.

Deliverables:

- Updated `schema.prisma`
- Migration notes
- Any backfill steps (if needed)

---

## Leaderboard & stats skill

**Use when:** daily solo logic, match history, ranking display.

Rules:

- Daily target deterministic (seeded by date + timezone choice).
- Persist daily solo completion to `LeaderboardDailySolo`.
- Don’t reveal target until match ends.

Deliverables:

- DB writes + query endpoints
- UI rendering
- Test scenarios (ties)

---

## Railway deployment skill

**Use when:** wiring services, env vars, ports, migrations, production behavior.

Rules:

- Don’t assume env var names; verify Railway-provided vars.
- Ensure Socket.IO CORS allowlist matches web domain.
- Use Node 20+ runtime.
- Provide clear steps for:
  - Postgres service
  - realtime service
  - web service
  - Prisma migrations in production

Deliverables:

- Env var list
- Railway setup steps
- Deploy + smoke test steps

---

## Debugging & incident response skill

**Use when:** disconnects, turn desync, “works locally but not on Railway”, slow rank computation.

Approach:

1. Reproduce with minimal steps.
2. Evidence:
   - realtime logs (roomCode, matchId)
   - socket connect/disconnect events
   - DB writes (match created? guesses saved?)
3. Hypothesize → test smallest fix first.
4. Fix with minimal diff + guardrails:
   - handler guards
   - state machine checks
   - resync on reconnect

Deliverables:

- Root cause
- Fix summary
- Prevention (tests/logging)

---

## Code quality & PR-ready skill

Checklist:

- lint passes
- typecheck passes
- schemas updated when events change
- no secrets committed
- README updated if setup changed

Deliverable:

- PR-style summary (what/why/how to test)

---

## When requirements are missing

If a task is ambiguous, assume:

- MVP-first implementation
- simplest UI that matches existing patterns
- safe defaults (validation + server authority)
- list assumptions at the top of the solution

---

## Codex usage rule (how to use this with the build guide)

Whenever Codex is asked to build or change anything:

1. Read `/docs/skills.md` first and follow it strictly.
2. Read `/docs/spec/contexto_multiplayer_build_guide.md` next and implement requirements exactly.
3. Work in this order:
   - `packages/shared` (schemas/types)
   - `packages/db` (Prisma)
   - `apps/realtime` (server handlers/state machine)
   - `apps/web` (UI + client wiring)
4. Provide:
   - file-by-file changes
   - commands to run
   - test checklist (multi-tab)
   - deploy checklist (Railway)
