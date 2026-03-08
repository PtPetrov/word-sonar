import http from "node:http";
import { randomUUID } from "node:crypto";
import express from "express";
import {
  COUNTDOWN_SECONDS_DEFAULT,
  ROOM_CODE_LENGTH,
  TEAM_SIZE_BY_MODE,
  TURN_MS_DEFAULT,
  type GuessResult,
  type Mode,
  type RoomState as RoomStatePayload,
  type TeamId,
  type TurnState,
  validateClientPayload,
  type ClientToServerEvents,
  type InterServerEvents,
  type ServerToClientEvents,
  type SocketData
} from "@word-hunt/shared";
import { prisma, type MatchMode, type MatchStatus, type RoomStatus } from "@word-hunt/db";
import { Server } from "socket.io";
import { RankEngine } from "./rank-engine.js";
import { serverConfig } from "./config.js";

interface PlayerState {
  id: string;
  displayName: string;
  teamId: TeamId | null;
  isCaptain: boolean;
  connected: boolean;
  socketId: string;
}

interface TeamState {
  id: TeamId;
  captainId: string | null;
  playerIds: string[];
  maxPlayers: number;
  rotationCursor: number;
}

interface RoomState {
  roomCode: string;
  mode: Mode;
  status: RoomStatus;
  hostId: string;
  turnMs: number;
  players: Map<string, PlayerState>;
  teams: Map<TeamId, TeamState>;
  matchId: string | null;
  targetWord: string | null;
  rankByIndex: Int32Array | null;
  guessedSet: Set<string>;
  guessHistory: GuessResult[];
  activeTeamId: TeamId | null;
  activePlayerId: string | null;
  turnNumber: number;
  teamBestRank: Map<TeamId, number>;
  startTime: number | null;
  countdownEndsAt: number | null;
  countdownTimer: NodeJS.Timeout | null;
  turnTimer: NodeJS.Timeout | null;
  turnEndsAt: number | null;
  disconnectTimers: Map<string, NodeJS.Timeout>;
  dailyDate: string | null;
  soloLeaderboardEligible: boolean;
  hintsUsed: number;
  contextWords: string[];
}

const app = express();
const server = http.createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(
  server,
  {
    cors: {
      origin: serverConfig.corsOrigin === "*" ? true : serverConfig.corsOrigin,
      methods: ["GET", "POST"]
    }
  }
);

const engine = new RankEngine({
  dataPath: serverConfig.dataPath,
  dictionaryVersion: serverConfig.dictionaryVersion,
  expectedVectorDim: serverConfig.vectorDim
});

const rooms = new Map<string, RoomState>();
const SOCKET_EVENT_ERROR = "error" as const;
const OFFLINE_MATCH_PREFIX = "offline-";
let dbUnavailable = false;

function makeTeam(mode: Mode, teamId: TeamId): TeamState {
  if (mode === "solo" && teamId === "SOLO") {
    return { id: teamId, captainId: null, playerIds: [], maxPlayers: 1, rotationCursor: 0 };
  }

  if (mode === "coop" && teamId === "COOP") {
    return {
      id: teamId,
      captainId: null,
      playerIds: [],
      maxPlayers: TEAM_SIZE_BY_MODE.coop,
      rotationCursor: 0
    };
  }

  if ((mode === "1v1" || mode === "3v3") && (teamId === "A" || teamId === "B")) {
    return {
      id: teamId,
      captainId: null,
      playerIds: [],
      maxPlayers: TEAM_SIZE_BY_MODE[mode],
      rotationCursor: 0
    };
  }

  throw new Error(`Invalid mode/team combination: ${mode}/${teamId}`);
}

function createRoomState(input: {
  roomCode: string;
  mode: Mode;
  hostId: string;
  turnMs?: number;
}): RoomState {
  const teams = new Map<TeamId, TeamState>();
  if (input.mode === "solo") {
    teams.set("SOLO", makeTeam(input.mode, "SOLO"));
  } else if (input.mode === "coop") {
    teams.set("COOP", makeTeam(input.mode, "COOP"));
  } else {
    teams.set("A", makeTeam(input.mode, "A"));
    teams.set("B", makeTeam(input.mode, "B"));
  }

  return {
    roomCode: input.roomCode,
    mode: input.mode,
    status: "forming",
    hostId: input.hostId,
    turnMs: input.turnMs ?? TURN_MS_DEFAULT,
    players: new Map(),
    teams,
    matchId: null,
    targetWord: null,
    rankByIndex: null,
    guessedSet: new Set(),
    guessHistory: [],
    activeTeamId: null,
    activePlayerId: null,
    turnNumber: 1,
    teamBestRank: new Map(),
    startTime: null,
    countdownEndsAt: null,
    countdownTimer: null,
    turnTimer: null,
    turnEndsAt: null,
    disconnectTimers: new Map(),
    dailyDate: null,
    soloLeaderboardEligible: false,
    hintsUsed: 0,
    contextWords: []
  };
}

function mapModeToPrisma(mode: Mode): MatchMode {
  if (mode === "solo") {
    return "solo";
  }

  if (mode === "coop") {
    return "coop";
  }

  if (mode === "1v1") {
    return "one_v_one";
  }

  return "three_v_three";
}

function mapStatusToPrisma(status: RoomStatus): MatchStatus {
  if (status === "finished") {
    return "finished";
  }

  if (status === "aborted") {
    return "aborted";
  }

  return "active";
}

function teamIdsForMode(mode: Mode): TeamId[] {
  if (mode === "solo") {
    return ["SOLO"];
  }

  if (mode === "coop") {
    return ["COOP"];
  }

  return ["A", "B"];
}

function buildRoomStatePayload(room: RoomState): RoomStatePayload {
  return {
    roomCode: room.roomCode,
    mode: room.mode,
    status: room.status,
    hostId: room.hostId,
    turnMs: room.turnMs,
    players: [...room.players.values()].map((player) => ({
      id: player.id,
      displayName: player.displayName,
      teamId: player.teamId,
      isCaptain: player.isCaptain,
      connected: player.connected
    })),
    teams: [...room.teams.values()].map((team) => ({
      id: team.id,
      playerIds: [...team.playerIds],
      captainId: team.captainId,
      maxPlayers: team.maxPlayers
    })),
    countdownEndsAt: room.countdownEndsAt,
    matchId: room.matchId,
    dailyDate: room.dailyDate,
    hintsUsed: room.hintsUsed,
    contextWords: room.contextWords
  };
}

function buildTurnStatePayload(room: RoomState): TurnState | null {
  if (!room.activePlayerId || !room.activeTeamId || !room.turnTimer || room.status !== "in_game") {
    return null;
  }

  return {
    activeTeamId: room.activeTeamId,
    activePlayerId: room.activePlayerId,
    turnNumber: room.turnNumber,
    endsAt: room.turnEndsAt ?? Date.now() + room.turnMs
  };
}

function emitRoomState(room: RoomState): void {
  io.to(room.roomCode).emit("room:state", buildRoomStatePayload(room));
}

function emitTurnState(room: RoomState): void {
  const payload = buildTurnStatePayload(room);
  if (!payload) {
    return;
  }

  io.to(room.roomCode).emit("turn:state", payload);
}

function emitError(socketId: string, code: string, message: string): void {
  io.to(socketId).emit(SOCKET_EVENT_ERROR, { code, message });
}

function nowDateInTimezone(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function isOfflineMatchId(matchId: string | null): boolean {
  return Boolean(matchId && matchId.startsWith(OFFLINE_MATCH_PREFIX));
}

async function safeDb<T>(action: () => Promise<T>, context: string): Promise<T | null> {
  try {
    const result = await action();
    if (dbUnavailable) {
      dbUnavailable = false;
      // eslint-disable-next-line no-console
      console.info("[db] Database connection restored.");
    }
    return result;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P1001"
    ) {
      if (!dbUnavailable) {
        dbUnavailable = true;
        // eslint-disable-next-line no-console
        console.warn(
          "[db] Database is unavailable at 127.0.0.1:5432. Continuing in offline mode without persistence."
        );
      }
      return null;
    }

    // eslint-disable-next-line no-console
    console.error(`[db] ${context} failed`, error);
    return null;
  }
}

function makeRoomCode(): string {
  const alphabet = "0123456789";

  while (true) {
    let code = "";
    for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }

    if (!rooms.has(code)) {
      return code;
    }
  }
}

function buildSoloHint(room: RoomState): { word: string; rank: number } | null {
  if (room.mode !== "solo" || !room.rankByIndex || room.guessHistory.length === 0) {
    return null;
  }

  const bestRank = room.guessHistory.reduce((lowest, guess) => Math.min(lowest, guess.rank), Number.MAX_SAFE_INTEGER);
  if (!Number.isFinite(bestRank) || bestRank <= 2) {
    return null;
  }

  const targetRank = Math.max(2, Math.floor(bestRank * 0.72));
  let fallback: { word: string; rank: number } | null = null;
  let bestCandidate: { word: string; rank: number; distance: number } | null = null;

  for (let index = 0; index < engine.vocab.length; index += 1) {
    const word = engine.vocab[index];
    const rank = room.rankByIndex[index];
    if (
      !word ||
      !rank ||
      rank <= 1 ||
      rank >= bestRank ||
      room.guessedSet.has(word) ||
      (word.length >= 4 &&
        word.endsWith("s") &&
        !word.endsWith("ss") &&
        !word.endsWith("us") &&
        !word.endsWith("is") &&
        !word.endsWith("ous"))
    ) {
      continue;
    }

    if (!fallback || rank < fallback.rank) {
      fallback = { word, rank };
    }

    const distance = Math.abs(rank - targetRank);
    if (!bestCandidate || distance < bestCandidate.distance) {
      bestCandidate = { word, rank, distance };
    }
  }

  if (bestCandidate) {
    return { word: bestCandidate.word, rank: bestCandidate.rank };
  }

  return fallback;
}

async function ensureUser(user: { id: string; displayName: string }): Promise<void> {
  await safeDb(
    () =>
      prisma.user.upsert({
        where: { id: user.id },
        create: {
          id: user.id,
          displayName: user.displayName
        },
        update: {
          displayName: user.displayName
        }
      }),
    `ensureUser(${user.id})`
  );
}

function createAnonymousSoloUser() {
  return {
    id: randomUUID(),
    displayName: "Guest"
  };
}

function addPlayerToTeam(room: RoomState, player: PlayerState, teamId: TeamId, isCaptain: boolean): void {
  const team = room.teams.get(teamId);
  if (!team) {
    throw new Error(`Team not found: ${teamId}`);
  }

  if (team.playerIds.length >= team.maxPlayers) {
    throw new Error("Team is full");
  }

  player.teamId = teamId;
  player.isCaptain = isCaptain;
  room.players.set(player.id, player);

  if (!team.playerIds.includes(player.id)) {
    team.playerIds.push(player.id);
  }

  if (isCaptain || !team.captainId) {
    team.captainId = player.id;
  }
}

function removePlayerFromRoom(room: RoomState, userId: string): void {
  const player = room.players.get(userId);
  if (!player) {
    return;
  }

  const disconnectTimer = room.disconnectTimers.get(userId);
  if (disconnectTimer) {
    clearTimeout(disconnectTimer);
  }
  room.disconnectTimers.delete(userId);

  if (player.teamId) {
    const team = room.teams.get(player.teamId);
    if (team) {
      team.playerIds = team.playerIds.filter((id) => id !== userId);
      if (team.captainId === userId) {
        team.captainId = team.playerIds[0] ?? null;
      }

      if (team.rotationCursor >= team.playerIds.length) {
        team.rotationCursor = 0;
      }
    }
  }

  room.players.delete(userId);

  if (room.hostId === userId) {
    room.hostId = room.players.values().next().value?.id ?? "";
  }
}

function clearCountdown(room: RoomState): void {
  if (room.countdownTimer) {
    clearTimeout(room.countdownTimer);
    room.countdownTimer = null;
  }

  room.countdownEndsAt = null;
}

function clearTurnTimer(room: RoomState): void {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
  room.turnEndsAt = null;
}

function isVersusFull(room: RoomState): boolean {
  if (room.mode !== "1v1" && room.mode !== "3v3") {
    return false;
  }

  const teamA = room.teams.get("A");
  const teamB = room.teams.get("B");
  return Boolean(teamA && teamB && teamA.playerIds.length === teamA.maxPlayers && teamB.playerIds.length === teamB.maxPlayers);
}

function maybeCancelCountdown(room: RoomState): void {
  if (room.status !== "countdown") {
    return;
  }

  if (!isVersusFull(room)) {
    clearCountdown(room);
    room.status = "forming";
    emitRoomState(room);
  }
}

async function createRoomRecord(room: RoomState): Promise<void> {
  if (!room.hostId) {
    return;
  }

  await safeDb(
    () =>
      prisma.room.upsert({
        where: { code: room.roomCode },
        create: {
          code: room.roomCode,
          createdByUserId: room.hostId,
          status: room.status,
          mode: mapModeToPrisma(room.mode)
        },
        update: {
          status: room.status,
          mode: mapModeToPrisma(room.mode)
        }
      }),
    `createRoomRecord(${room.roomCode})`
  );
}

async function persistRoom(room: RoomState): Promise<void> {
  if (!room.hostId) {
    return;
  }

  await safeDb(
    () =>
      prisma.room.upsert({
        where: { code: room.roomCode },
        create: {
          code: room.roomCode,
          createdByUserId: room.hostId,
          status: room.status,
          mode: mapModeToPrisma(room.mode)
        },
        update: {
          status: room.status,
          mode: mapModeToPrisma(room.mode)
        }
      }),
    `persistRoom(${room.roomCode})`
  );
}

function selectNextPlayer(room: RoomState, teamId: TeamId): string | null {
  const team = room.teams.get(teamId);
  if (!team || team.playerIds.length === 0) {
    return null;
  }

  let selected: string | null = null;
  for (let i = 0; i < team.playerIds.length; i += 1) {
    const idx = (team.rotationCursor + i) % team.playerIds.length;
    const candidateId = team.playerIds[idx];
    if (!candidateId) {
      continue;
    }
    const candidate = room.players.get(candidateId);
    if (candidate?.connected) {
      selected = candidateId;
      team.rotationCursor = (idx + 1) % team.playerIds.length;
      break;
    }
  }

  if (!selected) {
    selected = team.playerIds[team.rotationCursor % team.playerIds.length] ?? null;
    team.rotationCursor = (team.rotationCursor + 1) % team.playerIds.length;
  }

  return selected;
}

function getOpponentTeamId(teamId: TeamId): TeamId | null {
  if (teamId === "A") {
    return "B";
  }
  if (teamId === "B") {
    return "A";
  }
  return null;
}

function scheduleTurnTimeout(room: RoomState): void {
  clearTurnTimer(room);
  room.turnEndsAt = Date.now() + room.turnMs;
  room.turnTimer = setTimeout(() => {
    void advanceTurn(room);
  }, room.turnMs);
}

async function startMatch(room: RoomState, options?: { dailyDate?: string; targetWord?: string }): Promise<void> {
  if (room.status !== "forming" && room.status !== "countdown") {
    return;
  }

  clearCountdown(room);

  let targetWord: string;
  let rankMap: ReturnType<RankEngine["buildRankMap"]>;
  try {
    targetWord =
      options?.targetWord ??
      (options?.dailyDate ? engine.pickDailyTarget(options.dailyDate) : engine.pickRandomTarget());
    rankMap = engine.buildRankMap(targetWord);
  } catch (error) {
    room.status = "aborted";
    const message =
      error instanceof Error ? error.message : "Could not start a new game target selection";
    io.to(room.roomCode).emit("error", {
      code: "TARGET_SELECTION_FAILED",
      message
    });
    emitRoomState(room);
    await persistRoom(room);
    return;
  }

  room.status = "in_game";
  room.targetWord = targetWord;
  room.rankByIndex = rankMap.rankByIndex;
  room.guessedSet.clear();
  room.guessHistory = [];
  room.hintsUsed = 0;
  room.contextWords = room.mode === "solo" ? engine.pickContextWords(room.rankByIndex, 3) : [];
  room.turnNumber = 1;
  room.startTime = Date.now();
  room.dailyDate = options?.dailyDate ?? null;
  room.teamBestRank.clear();

  for (const teamId of teamIdsForMode(room.mode)) {
    room.teamBestRank.set(teamId, Number.POSITIVE_INFINITY);
  }

  const match = await safeDb(
    () =>
      prisma.match.create({
        data: {
          mode: mapModeToPrisma(room.mode),
          dictionaryVersion: engine.dictionaryVersion,
          targetWord,
          turnMs: room.turnMs,
          status: "active",
          dailyDate: room.dailyDate ? new Date(`${room.dailyDate}T00:00:00.000Z`) : null,
          players: {
            createMany: {
              data: [...room.players.values()].map((player) => ({
                userId: player.id,
                teamId: player.teamId ?? "",
                isHost: player.id === room.hostId
              }))
            }
          }
        }
      }),
    `createMatch(${room.roomCode})`
  );

  room.matchId = match?.id ?? `${OFFLINE_MATCH_PREFIX}${randomUUID()}`;

  room.activeTeamId = room.mode === "solo" ? "SOLO" : room.mode === "coop" ? "COOP" : "A";
  room.activePlayerId = selectNextPlayer(room, room.activeTeamId);
  if (!room.activePlayerId) {
    room.status = "aborted";
    if (room.matchId && !isOfflineMatchId(room.matchId)) {
      await safeDb(
        () =>
          prisma.match.update({
            where: { id: room.matchId ?? "" },
            data: {
              endedAt: new Date(),
              status: "aborted"
            }
          }),
        `abortMatchOnStart(${room.matchId})`
      );
    }
    emitRoomState(room);
    await persistRoom(room);
    return;
  }

  io.to(room.roomCode).emit("game:started", {
    matchId: room.matchId,
    mode: room.mode,
    turnMs: room.turnMs,
    dictionaryVersion: engine.dictionaryVersion
  });

  scheduleTurnTimeout(room);
  emitRoomState(room);
  emitTurnState(room);
  await persistRoom(room);
}

async function finishMatch(room: RoomState, winnerTeamId: TeamId, winningWord: string): Promise<void> {
  clearTurnTimer(room);
  clearCountdown(room);

  room.status = "finished";
  const durationMs = room.startTime ? Date.now() - room.startTime : 0;

  if (room.matchId && !isOfflineMatchId(room.matchId)) {
    await safeDb(
      () =>
        prisma.match.update({
          where: { id: room.matchId ?? "" },
          data: {
            endedAt: new Date(),
            winnerTeamId,
            status: mapStatusToPrisma(room.status)
          }
        }),
      `finishMatch(${room.matchId})`
    );
  }

  if (
    room.mode === "solo" &&
    room.soloLeaderboardEligible &&
    room.dailyDate &&
    room.matchId &&
    !isOfflineMatchId(room.matchId) &&
    room.activePlayerId
  ) {
    const dailyDate = new Date(`${room.dailyDate}T00:00:00.000Z`);
    await safeDb(
      () =>
        prisma.dailySoloEntry.upsert({
          where: {
            date_userId: {
              date: dailyDate,
              userId: room.activePlayerId ?? ""
            }
          },
          create: {
            date: dailyDate,
            userId: room.activePlayerId ?? "",
            turnsToSolve: room.turnNumber,
            timeMs: durationMs
          },
          update: {
            turnsToSolve: room.turnNumber,
            timeMs: durationMs
          }
        }),
      `upsertDailySolo(${room.activePlayerId})`
    );
  }

  io.to(room.roomCode).emit("game:won", {
    winnerTeamId,
    winningWord,
    turns: room.turnNumber,
    durationMs
  });

  emitRoomState(room);
  await persistRoom(room);
}

async function finishByForfeit(room: RoomState, loserUserId: string): Promise<void> {
  const loser = room.players.get(loserUserId);
  const loserTeamId = loser?.teamId ?? null;
  const winnerTeamId = loserTeamId ? getOpponentTeamId(loserTeamId) : null;

  if (!loserTeamId || !winnerTeamId) {
    return;
  }

  clearTurnTimer(room);
  clearCountdown(room);

  room.status = "finished";

  if (room.matchId && !isOfflineMatchId(room.matchId)) {
    await safeDb(
      () =>
        prisma.match.update({
          where: { id: room.matchId ?? "" },
          data: {
            endedAt: new Date(),
            winnerTeamId,
            status: mapStatusToPrisma(room.status)
          }
        }),
      `finishByForfeit(${room.matchId})`
    );
  }

  const winnerUserId =
    room.players.get(room.teams.get(winnerTeamId)?.playerIds[0] ?? "")?.id ?? null;

  io.to(room.roomCode).emit("game:forfeit", {
    winnerTeamId,
    loserTeamId,
    winnerUserId,
    loserUserId
  });

  emitRoomState(room);
  await persistRoom(room);
}

async function advanceTurn(room: RoomState): Promise<void> {
  if (room.status !== "in_game") {
    return;
  }

  clearTurnTimer(room);

  if (room.mode === "1v1" || room.mode === "3v3") {
    room.activeTeamId = room.activeTeamId === "A" ? "B" : "A";
  } else if (room.mode === "solo") {
    room.activeTeamId = "SOLO";
  } else {
    room.activeTeamId = "COOP";
  }

  const nextPlayerId = room.activeTeamId ? selectNextPlayer(room, room.activeTeamId) : null;

  if (!nextPlayerId || !room.activeTeamId) {
    room.status = "aborted";
    if (room.matchId && !isOfflineMatchId(room.matchId)) {
      await safeDb(
        () =>
          prisma.match.update({
            where: { id: room.matchId ?? "" },
            data: {
              endedAt: new Date(),
              status: "aborted"
            }
          }),
        `abortMatchOnAdvance(${room.matchId})`
      );
    }
    emitRoomState(room);
    await persistRoom(room);
    return;
  }

  room.activePlayerId = nextPlayerId;
  room.turnNumber += 1;
  scheduleTurnTimeout(room);
  emitTurnState(room);
}

async function onGuess(socketId: string, payload: { roomCode: string; word: string }): Promise<void> {
  const room = rooms.get(payload.roomCode);
  if (!room) {
    emitError(socketId, "ROOM_NOT_FOUND", "Room not found");
    return;
  }

  if (room.status !== "in_game") {
    emitError(socketId, "INVALID_STATE", "Game is not in progress");
    return;
  }

  const socket = io.sockets.sockets.get(socketId);
  const userId = socket?.data.userId;
  if (!userId || userId !== room.activePlayerId) {
    emitError(socketId, "NOT_YOUR_TURN", "Only the active player can guess");
    return;
  }

  if (!room.rankByIndex || !room.activeTeamId) {
    emitError(socketId, "ROOM_INVALID", "Room state is invalid");
    return;
  }

  const word = payload.word.trim().toLowerCase();
  const validation = engine.validateGuess(word);
  if (!validation.ok) {
    emitError(socketId, validation.code, validation.message);
    return;
  }

  const isDuplicate = room.guessedSet.has(word);
  if (!isDuplicate) {
    room.guessedSet.add(word);
  }

  const rank = engine.getRank(word, room.rankByIndex);
  const teamId = room.activeTeamId;
  const bestBefore = room.teamBestRank.get(teamId) ?? Number.POSITIVE_INFINITY;
  const isNewTeamBest = rank < bestBefore;
  if (isNewTeamBest) {
    room.teamBestRank.set(teamId, rank);
  }

  const result: GuessResult = {
    word,
    rank,
    byUserId: userId,
    teamId,
    turnNumber: room.turnNumber,
    isDuplicate,
    isNewTeamBest,
    teamBestRank: Math.min(rank, bestBefore),
    createdAt: Date.now()
  };

  room.guessHistory.push(result);
  if (room.guessHistory.length > 50) {
    room.guessHistory.shift();
  }

  if (room.matchId && !isOfflineMatchId(room.matchId)) {
    await safeDb(
      () =>
        prisma.guess.create({
          data: {
            matchId: room.matchId ?? "",
            turnNumber: room.turnNumber,
            userId,
            teamId,
            word,
            rank
          }
        }),
      `insertGuess(${room.matchId},${word})`
    );
  }

  io.to(room.roomCode).emit("guess:result", result);

  if (rank === 1) {
    await finishMatch(room, teamId, room.targetWord ?? word);
    return;
  }

  await advanceTurn(room);
}

async function onPass(socketId: string, payload: { roomCode: string }): Promise<void> {
  const room = rooms.get(payload.roomCode);
  if (!room) {
    emitError(socketId, "ROOM_NOT_FOUND", "Room not found");
    return;
  }

  if (room.status !== "in_game") {
    emitError(socketId, "INVALID_STATE", "Game is not in progress");
    return;
  }

  const socket = io.sockets.sockets.get(socketId);
  if (socket?.data.userId !== room.activePlayerId) {
    emitError(socketId, "NOT_YOUR_TURN", "Only the active player can pass");
    return;
  }

  await advanceTurn(room);
}

function validatePayloadOrEmit<T extends keyof ClientToServerEvents>(
  socketId: string,
  event: T,
  payload: unknown
): { success: true; data: Parameters<ClientToServerEvents[T]>[0] } | null {
  const parsed = validateClientPayload(event, payload);
  if (!parsed.success) {
    emitError(socketId, "BAD_PAYLOAD", parsed.error.issues[0]?.message ?? "Invalid payload");
    return null;
  }

  return {
    success: true,
    data: parsed.data as Parameters<ClientToServerEvents[T]>[0]
  };
}

function onReconnectSync(socketId: string, room: RoomState): void {
  io.to(socketId).emit("room:state", buildRoomStatePayload(room));

  if (room.status === "in_game" && room.activePlayerId && room.activeTeamId) {
    io.to(socketId).emit("turn:state", {
      activeTeamId: room.activeTeamId,
      activePlayerId: room.activePlayerId,
      turnNumber: room.turnNumber,
      endsAt: room.turnEndsAt ?? Date.now() + room.turnMs
    });
  }

  for (const guess of room.guessHistory.slice(-20)) {
    io.to(socketId).emit("guess:result", guess);
  }
}

function maybeDeleteRoom(room: RoomState): void {
  if (room.players.size === 0) {
    clearCountdown(room);
    clearTurnTimer(room);
    rooms.delete(room.roomCode);
  }
}

function maybeStartCountdown(room: RoomState): void {
  if (room.status !== "forming" || !isVersusFull(room)) {
    return;
  }

  room.status = "countdown";
  room.countdownEndsAt = Date.now() + serverConfig.countdownSeconds * 1000;

  io.to(room.roomCode).emit("lobby:countdown", {
    roomCode: room.roomCode,
    secondsLeft: serverConfig.countdownSeconds || COUNTDOWN_SECONDS_DEFAULT,
    startsAt: Date.now(),
    endsAt: room.countdownEndsAt
  });

  emitRoomState(room);

  room.countdownTimer = setTimeout(() => {
    void startMatch(room);
  }, serverConfig.countdownSeconds * 1000);
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    uptimeSec: Math.floor(process.uptime()),
    rooms: rooms.size,
    dictionaryVersion: engine.dictionaryVersion,
    vocabSize: engine.vocab.length,
    targetSize: engine.targets.length
  });
});

io.on("connection", (socket) => {
  socket.on("lobby:createVersus", async (payload) => {
    const parsed = validatePayloadOrEmit(socket.id, "lobby:createVersus", payload);
    if (!parsed?.success) {
      return;
    }

    const { user, mode, turnMs } = parsed.data;
    await ensureUser(user);

    const roomCode = makeRoomCode();
    const room = createRoomState({
      roomCode,
      mode,
      hostId: user.id,
      turnMs: turnMs ?? serverConfig.turnMsDefault
    });

    const player: PlayerState = {
      id: user.id,
      displayName: user.displayName,
      teamId: null,
      isCaptain: true,
      connected: true,
      socketId: socket.id
    };

    addPlayerToTeam(room, player, "A", true);
    rooms.set(roomCode, room);

    socket.data.userId = user.id;
    socket.data.roomCode = roomCode;
    socket.join(roomCode);

    await createRoomRecord(room);

    socket.emit("lobby:created", {
      roomCode,
      mode,
      versusLink: `/room/${roomCode}`,
      teamALink: `/room/${roomCode}?team=A`,
      teamBLink: `/room/${roomCode}?team=B`
    });

    emitRoomState(room);
  });

  socket.on("lobby:createCoop", async (payload) => {
    const parsed = validatePayloadOrEmit(socket.id, "lobby:createCoop", payload);
    if (!parsed?.success) {
      return;
    }

    const { user, turnMs } = parsed.data;
    await ensureUser(user);

    const roomCode = makeRoomCode();
    const room = createRoomState({
      roomCode,
      mode: "coop",
      hostId: user.id,
      turnMs: turnMs ?? serverConfig.turnMsDefault
    });

    const player: PlayerState = {
      id: user.id,
      displayName: user.displayName,
      teamId: null,
      isCaptain: true,
      connected: true,
      socketId: socket.id
    };

    addPlayerToTeam(room, player, "COOP", true);
    rooms.set(roomCode, room);

    socket.data.userId = user.id;
    socket.data.roomCode = roomCode;
    socket.join(roomCode);

    await createRoomRecord(room);

    socket.emit("lobby:created", {
      roomCode,
      mode: "coop",
      versusLink: `/room/${roomCode}`,
      teamALink: `/room/${roomCode}`,
      teamBLink: `/room/${roomCode}`
    });

    emitRoomState(room);
  });

  socket.on("room:join", async (payload) => {
    const parsed = validatePayloadOrEmit(socket.id, "room:join", payload);
    if (!parsed?.success) {
      return;
    }

    const { roomCode, user } = parsed.data;
    const room = rooms.get(roomCode);

    if (!room) {
      emitError(socket.id, "ROOM_NOT_FOUND", "Room not found");
      return;
    }

    await ensureUser(user);
    socket.data.userId = user.id;
    socket.data.roomCode = roomCode;
    socket.join(roomCode);

    const existing = room.players.get(user.id);
    if (existing) {
      existing.connected = true;
      existing.socketId = socket.id;
      existing.displayName = user.displayName;
      const disconnectTimer = room.disconnectTimers.get(user.id);
      if (disconnectTimer) {
        clearTimeout(disconnectTimer);
      }
      room.disconnectTimers.delete(user.id);
      onReconnectSync(socket.id, room);
      emitRoomState(room);
      return;
    }

    if (room.mode === "coop" && room.status === "forming") {
      const coopTeam = room.teams.get("COOP");
      if (!coopTeam) {
        emitError(socket.id, "TEAM_NOT_FOUND", "Co-op team not found");
        return;
      }

      if (coopTeam.playerIds.length >= coopTeam.maxPlayers) {
        emitError(socket.id, "ROOM_FULL", "Co-op room is full");
        return;
      }

      const player: PlayerState = {
        id: user.id,
        displayName: user.displayName,
        teamId: null,
        isCaptain: false,
        connected: true,
        socketId: socket.id
      };
      addPlayerToTeam(room, player, "COOP", false);
      emitRoomState(room);
      return;
    }

    emitRoomState(room);
  });

  socket.on("lobby:createTeam", async (payload) => {
    const parsed = validatePayloadOrEmit(socket.id, "lobby:createTeam", payload);
    if (!parsed?.success) {
      return;
    }

    const { roomCode, user } = parsed.data;
    const room = rooms.get(roomCode);

    if (!room) {
      emitError(socket.id, "ROOM_NOT_FOUND", "Room not found");
      return;
    }

    if (room.mode !== "1v1" && room.mode !== "3v3") {
      emitError(socket.id, "INVALID_MODE", "Manual teams are only for versus matches");
      return;
    }

    if (room.status !== "forming" && room.status !== "countdown") {
      emitError(socket.id, "INVALID_STATE", "Cannot create Team B after the match starts");
      return;
    }

    await ensureUser(user);

    const existingPlayer = room.players.get(user.id);
    if (existingPlayer?.teamId) {
      emitError(socket.id, "ALREADY_ON_TEAM", "You already joined a team");
      return;
    }

    const teamB = room.teams.get("B");
    if (!teamB) {
      emitError(socket.id, "TEAM_NOT_FOUND", "Team B does not exist");
      return;
    }

    if (teamB.playerIds.length > 0) {
      emitError(socket.id, "TEAM_ALREADY_CREATED", "Team B already exists");
      return;
    }

    const player: PlayerState = {
      id: user.id,
      displayName: user.displayName,
      teamId: null,
      isCaptain: true,
      connected: true,
      socketId: socket.id
    };

    addPlayerToTeam(room, player, "B", true);

    socket.data.userId = user.id;
    socket.data.roomCode = roomCode;
    socket.join(roomCode);

    maybeStartCountdown(room);
    emitRoomState(room);
  });

  socket.on("lobby:joinTeam", async (payload) => {
    const parsed = validatePayloadOrEmit(socket.id, "lobby:joinTeam", payload);
    if (!parsed?.success) {
      return;
    }

    const { roomCode, teamId, user } = parsed.data;
    const room = rooms.get(roomCode);

    if (!room) {
      emitError(socket.id, "ROOM_NOT_FOUND", "Room not found");
      return;
    }

    if (room.mode !== "1v1" && room.mode !== "3v3") {
      emitError(socket.id, "INVALID_MODE", "Joining explicit teams is only for versus matches");
      return;
    }

    if (room.status === "in_game" || room.status === "finished") {
      emitError(socket.id, "INVALID_STATE", "Cannot join after game start");
      return;
    }

    await ensureUser(user);

    const team = room.teams.get(teamId);
    if (!team) {
      emitError(socket.id, "TEAM_NOT_FOUND", "Team not found");
      return;
    }

    const existingPlayer = room.players.get(user.id);
    if (existingPlayer?.teamId && existingPlayer.teamId !== teamId) {
      emitError(socket.id, "TEAM_CONFLICT", "You are already on another team");
      return;
    }

    if (existingPlayer) {
      existingPlayer.connected = true;
      existingPlayer.socketId = socket.id;
      existingPlayer.displayName = user.displayName;
    } else {
      if (team.playerIds.length >= team.maxPlayers) {
        emitError(socket.id, "TEAM_FULL", "Team is full");
        return;
      }

      const player: PlayerState = {
        id: user.id,
        displayName: user.displayName,
        teamId: null,
        isCaptain: false,
        connected: true,
        socketId: socket.id
      };

      addPlayerToTeam(room, player, teamId, false);
    }

    socket.data.userId = user.id;
    socket.data.roomCode = roomCode;
    socket.join(roomCode);

    maybeStartCountdown(room);
    emitRoomState(room);
  });

  socket.on("solo:startDaily", async (payload) => {
    const parsed = validatePayloadOrEmit(socket.id, "solo:startDaily", payload);
    if (!parsed?.success) {
      return;
    }

    const { user, turnMs } = parsed.data;
    const resolvedUser = user ?? createAnonymousSoloUser();
    const isNamedGuest = Boolean(user);
    await ensureUser(resolvedUser);

    const roomCode = makeRoomCode();
    const room = createRoomState({
      roomCode,
      mode: "solo",
      hostId: resolvedUser.id,
      turnMs: turnMs ?? serverConfig.turnMsDefault
    });
    room.soloLeaderboardEligible = isNamedGuest;

    const player: PlayerState = {
      id: resolvedUser.id,
      displayName: resolvedUser.displayName,
      teamId: null,
      isCaptain: true,
      connected: true,
      socketId: socket.id
    };

    addPlayerToTeam(room, player, "SOLO", true);
    rooms.set(roomCode, room);

    socket.data.userId = resolvedUser.id;
    socket.data.roomCode = roomCode;
    socket.join(roomCode);

    await createRoomRecord(room);

    await startMatch(room);
  });

  socket.on("solo:hint", async (payload) => {
    const parsed = validatePayloadOrEmit(socket.id, "solo:hint", payload);
    if (!parsed?.success) {
      return;
    }

    const room = rooms.get(parsed.data.roomCode);
    if (!room) {
      emitError(socket.id, "ROOM_NOT_FOUND", "Room not found");
      return;
    }

    if (room.mode !== "solo") {
      emitError(socket.id, "INVALID_MODE", "Hints are only available in solo mode");
      return;
    }

    if (room.status !== "in_game") {
      emitError(socket.id, "INVALID_STATE", "Hints are only available during an active game");
      return;
    }

    if (socket.data.userId !== room.activePlayerId) {
      emitError(socket.id, "NOT_YOUR_TURN", "Only the active player can request a hint");
      return;
    }

    if (room.hintsUsed >= 3) {
      emitError(socket.id, "INVALID_STATE", "You have already used all 3 hints.");
      return;
    }

    const hint = buildSoloHint(room);
    if (!hint) {
      emitError(socket.id, "INVALID_STATE", "No hint is available yet");
      return;
    }

    room.hintsUsed += 1;
    emitRoomState(room);

    await onGuess(socket.id, {
      roomCode: parsed.data.roomCode,
      word: hint.word
    });
  });

  socket.on("solo:reveal", (payload) => {
    const parsed = validatePayloadOrEmit(socket.id, "solo:reveal", payload);
    if (!parsed?.success) {
      return;
    }

    const room = rooms.get(parsed.data.roomCode);
    if (!room) {
      emitError(socket.id, "ROOM_NOT_FOUND", "Room not found");
      return;
    }

    if (room.mode !== "solo") {
      emitError(socket.id, "INVALID_MODE", "Reveal is only available in solo mode");
      return;
    }

    if (!room.targetWord) {
      emitError(socket.id, "INVALID_STATE", "No target word is available");
      return;
    }

    io.to(socket.id).emit("solo:reveal", {
      word: room.targetWord
    });
  });

  socket.on("game:start", async (payload) => {
    const parsed = validatePayloadOrEmit(socket.id, "game:start", payload);
    if (!parsed?.success) {
      return;
    }

    const room = rooms.get(parsed.data.roomCode);
    if (!room) {
      emitError(socket.id, "ROOM_NOT_FOUND", "Room not found");
      return;
    }

    if (room.mode !== "coop") {
      emitError(socket.id, "INVALID_MODE", "Manual game:start is only available for co-op rooms");
      return;
    }

    if (room.status !== "forming") {
      emitError(socket.id, "INVALID_STATE", "Co-op room already started");
      return;
    }

    if (socket.data.userId !== room.hostId) {
      emitError(socket.id, "NOT_HOST", "Only the host can start a co-op match");
      return;
    }

    await startMatch(room);
  });

  socket.on("arena:giveUp", async (payload) => {
    const parsed = validatePayloadOrEmit(socket.id, "arena:giveUp", payload);
    if (!parsed?.success) {
      return;
    }

    const room = rooms.get(parsed.data.roomCode);
    if (!room) {
      emitError(socket.id, "ROOM_NOT_FOUND", "Room not found");
      return;
    }

    if (room.mode !== "1v1") {
      emitError(socket.id, "INVALID_MODE", "Give up is only available in 1v1 arenas");
      return;
    }

    if (room.status !== "in_game") {
      emitError(socket.id, "INVALID_STATE", "You can only give up during an active arena");
      return;
    }

    const userId = io.sockets.sockets.get(socket.id)?.data.userId;
    if (!userId || !room.players.has(userId)) {
      emitError(socket.id, "NOT_IN_ROOM", "You are not part of this arena");
      return;
    }

    await finishByForfeit(room, userId);
  });

  socket.on("arena:restart", async (payload) => {
    const parsed = validatePayloadOrEmit(socket.id, "arena:restart", payload);
    if (!parsed?.success) {
      return;
    }

    const room = rooms.get(parsed.data.roomCode);
    if (!room) {
      emitError(socket.id, "ROOM_NOT_FOUND", "Room not found");
      return;
    }

    if (room.mode !== "1v1") {
      emitError(socket.id, "INVALID_MODE", "Restart is only available in 1v1 arenas");
      return;
    }

    if (room.status !== "finished") {
      emitError(socket.id, "INVALID_STATE", "Arena must be finished before restarting");
      return;
    }

    if (!isVersusFull(room)) {
      emitError(socket.id, "INVALID_STATE", "Both players must still be in the arena");
      return;
    }

    room.status = "forming";
    room.activePlayerId = null;
    room.activeTeamId = null;
    room.turnNumber = 1;
    room.matchId = null;
    room.targetWord = null;
    room.rankByIndex = null;
    room.guessedSet.clear();
    room.guessHistory = [];
    room.teamBestRank.clear();
    room.startTime = null;
    room.countdownEndsAt = null;
    room.turnEndsAt = null;
    clearCountdown(room);
    clearTurnTimer(room);

    maybeStartCountdown(room);
    emitRoomState(room);
  });

  socket.on("turn:guess", async (payload) => {
    const parsed = validatePayloadOrEmit(socket.id, "turn:guess", payload);
    if (!parsed?.success) {
      return;
    }

    await onGuess(socket.id, parsed.data);
  });

  socket.on("turn:pass", async (payload) => {
    const parsed = validatePayloadOrEmit(socket.id, "turn:pass", payload);
    if (!parsed?.success) {
      return;
    }

    await onPass(socket.id, parsed.data);
  });

  socket.on("room:requestState", (payload) => {
    const parsed = validatePayloadOrEmit(socket.id, "room:requestState", payload);
    if (!parsed?.success) {
      return;
    }

    const room = rooms.get(parsed.data.roomCode);
    if (!room) {
      emitError(socket.id, "ROOM_NOT_FOUND", "Room not found");
      return;
    }

    onReconnectSync(socket.id, room);
  });

  socket.on("room:leave", (payload) => {
    const parsed = validatePayloadOrEmit(socket.id, "room:leave", payload);
    if (!parsed?.success) {
      return;
    }

    const roomCode = socket.data.roomCode;
    const userId = socket.data.userId;
    if (!roomCode || !userId) {
      return;
    }

    const room = rooms.get(roomCode);
    if (!room) {
      return;
    }

    removePlayerFromRoom(room, userId);
    maybeCancelCountdown(room);
    emitRoomState(room);
    maybeDeleteRoom(room);
  });

  socket.on("disconnect", () => {
    const roomCode = socket.data.roomCode;
    const userId = socket.data.userId;
    if (!roomCode || !userId) {
      return;
    }

    const room = rooms.get(roomCode);
    if (!room) {
      return;
    }

    const player = room.players.get(userId);
    if (!player) {
      return;
    }

    player.connected = false;

    if (room.status === "forming" || room.status === "countdown") {
      removePlayerFromRoom(room, userId);
      maybeCancelCountdown(room);
      emitRoomState(room);
      maybeDeleteRoom(room);
      return;
    }

    const timer = setTimeout(async () => {
      const latestRoom = rooms.get(roomCode);
      if (!latestRoom) {
        return;
      }

      const latestPlayer = latestRoom.players.get(userId);
      if (latestPlayer?.connected) {
        return;
      }

      removePlayerFromRoom(latestRoom, userId);

      if (latestRoom.players.size === 0 && latestRoom.matchId && latestRoom.status === "in_game") {
        latestRoom.status = "aborted";
        if (!isOfflineMatchId(latestRoom.matchId)) {
          await safeDb(
            () =>
              prisma.match.update({
                where: { id: latestRoom.matchId ?? "" },
                data: {
                  endedAt: new Date(),
                  status: "aborted"
                }
              }),
            `abortMatchOnDisconnect(${latestRoom.matchId})`
          );
        }
        await persistRoom(latestRoom);
      }

      maybeCancelCountdown(latestRoom);
      emitRoomState(latestRoom);
      maybeDeleteRoom(latestRoom);
    }, serverConfig.reconnectGraceMs);

    room.disconnectTimers.set(userId, timer);
    emitRoomState(room);
  });
});

server.listen(serverConfig.port, () => {
  // eslint-disable-next-line no-console
  console.log(
    `Realtime server on :${serverConfig.port} | dict=${engine.dictionaryVersion} | vocab=${engine.vocab.length}`
  );
});
