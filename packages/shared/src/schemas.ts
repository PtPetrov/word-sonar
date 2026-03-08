import { z } from "zod";
import {
  COUNTDOWN_SECONDS_DEFAULT,
  DISPLAY_NAME_REGEX,
  MODE_VALUES,
  ROOM_CODE_LENGTH,
  ROOM_STATUS_VALUES,
  TEAM_ID_VALUES,
  TURN_MS_DEFAULT,
  WORD_REGEX
} from "./constants.js";

export const ModeSchema = z.enum(MODE_VALUES);
export const RoomStatusSchema = z.enum(ROOM_STATUS_VALUES);
export const TeamIdSchema = z.enum(TEAM_ID_VALUES);

export const GuestUserSchema = z.object({
  id: z.string().uuid(),
  displayName: z
    .string()
    .trim()
    .min(2)
    .max(20)
    .regex(DISPLAY_NAME_REGEX, "Display name contains invalid characters")
});

export const RoomCodeSchema = z
  .string()
  .trim()
  .length(ROOM_CODE_LENGTH)
  .regex(/^\d+$/);

export const RoomPlayerSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  teamId: TeamIdSchema.nullable(),
  isCaptain: z.boolean(),
  connected: z.boolean()
});

export const RoomTeamSchema = z.object({
  id: TeamIdSchema,
  playerIds: z.array(z.string()),
  captainId: z.string().nullable(),
  maxPlayers: z.number().int().positive()
});

export const RoomStateSchema = z.object({
  roomCode: RoomCodeSchema,
  mode: ModeSchema,
  status: RoomStatusSchema,
  hostId: z.string(),
  turnMs: z.number().int().positive().default(TURN_MS_DEFAULT),
  players: z.array(RoomPlayerSchema),
  teams: z.array(RoomTeamSchema),
  countdownEndsAt: z.number().int().nullable(),
  matchId: z.string().nullable(),
  dailyDate: z.string().nullable(),
  hintsUsed: z.number().int().nonnegative().default(0),
  contextWords: z.array(z.string()).default([])
});

export const TurnStateSchema = z.object({
  activeTeamId: TeamIdSchema,
  activePlayerId: z.string(),
  turnNumber: z.number().int().positive(),
  endsAt: z.number().int()
});

export const GuessResultSchema = z.object({
  word: z.string().regex(WORD_REGEX),
  rank: z.number().int().positive(),
  byUserId: z.string(),
  teamId: TeamIdSchema,
  turnNumber: z.number().int().positive(),
  isDuplicate: z.boolean(),
  isNewTeamBest: z.boolean(),
  teamBestRank: z.number().int().positive(),
  createdAt: z.number().int()
});

export const GameStartedSchema = z.object({
  matchId: z.string(),
  mode: ModeSchema,
  turnMs: z.number().int().positive(),
  dictionaryVersion: z.string()
});

export const GameWonSchema = z.object({
  winnerTeamId: TeamIdSchema,
  winningWord: z.string().regex(WORD_REGEX),
  turns: z.number().int().positive(),
  durationMs: z.number().int().nonnegative()
});

export const GameForfeitSchema = z.object({
  winnerTeamId: TeamIdSchema,
  loserTeamId: TeamIdSchema,
  winnerUserId: z.string().nullable(),
  loserUserId: z.string().nullable()
});

export const ErrorPayloadSchema = z.object({
  code: z.string(),
  message: z.string()
});

export const DailyLeaderboardEntrySchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  turnsToSolve: z.number().int().positive(),
  timeMs: z.number().int().nonnegative()
});

export const DailyLeaderboardSchema = z.object({
  date: z.string(),
  entries: z.array(DailyLeaderboardEntrySchema)
});

export const SoloHintSchema = z.object({
  word: z.string(),
  rank: z.number().int().positive()
});

export const SoloRevealSchema = z.object({
  word: z.string()
});

export const ClientToServerSchemas = {
  "room:join": z.object({
    roomCode: RoomCodeSchema,
    user: GuestUserSchema
  }),
  "room:leave": z.object({}),
  "room:requestState": z.object({ roomCode: RoomCodeSchema }),
  "lobby:createVersus": z.object({
    mode: z.enum(["1v1", "3v3"]),
    user: GuestUserSchema,
    turnMs: z.number().int().positive().optional()
  }),
  "lobby:createCoop": z.object({
    user: GuestUserSchema,
    turnMs: z.number().int().positive().optional()
  }),
  "lobby:createTeam": z.object({
    roomCode: RoomCodeSchema,
    teamId: z.enum(["B"]),
    user: GuestUserSchema
  }),
  "lobby:joinTeam": z.object({
    roomCode: RoomCodeSchema,
    teamId: z.enum(["A", "B"]),
    user: GuestUserSchema
  }),
  "solo:startDaily": z.object({
    user: GuestUserSchema.optional(),
    turnMs: z.number().int().positive().optional()
  }),
  "solo:hint": z.object({
    roomCode: RoomCodeSchema
  }),
  "solo:reveal": z.object({
    roomCode: RoomCodeSchema
  }),
  "game:start": z.object({
    roomCode: RoomCodeSchema
  }),
  "arena:giveUp": z.object({
    roomCode: RoomCodeSchema
  }),
  "arena:restart": z.object({
    roomCode: RoomCodeSchema
  }),
  "turn:guess": z.object({
    roomCode: RoomCodeSchema,
    word: z
      .string()
      .trim()
      .toLowerCase()
      .regex(WORD_REGEX, "Only one English word")
  }),
  "turn:pass": z.object({ roomCode: RoomCodeSchema })
} as const;

export const ServerToClientSchemas = {
  error: ErrorPayloadSchema,
  "lobby:created": z.object({
    roomCode: RoomCodeSchema,
    mode: z.enum(["1v1", "3v3", "coop"]),
    versusLink: z.string(),
    teamALink: z.string(),
    teamBLink: z.string()
  }),
  "lobby:countdown": z.object({
    roomCode: RoomCodeSchema,
    secondsLeft: z.number().int().nonnegative().default(COUNTDOWN_SECONDS_DEFAULT),
    startsAt: z.number().int(),
    endsAt: z.number().int()
  }),
  "room:state": RoomStateSchema,
  "game:started": GameStartedSchema,
  "turn:state": TurnStateSchema,
  "guess:result": GuessResultSchema,
  "solo:hint": SoloHintSchema,
  "solo:reveal": SoloRevealSchema,
  "game:won": GameWonSchema,
  "game:forfeit": GameForfeitSchema,
  "leaderboard:dailySolo": DailyLeaderboardSchema
} as const;

export type Mode = z.infer<typeof ModeSchema>;
export type RoomStatus = z.infer<typeof RoomStatusSchema>;
export type TeamId = z.infer<typeof TeamIdSchema>;
export type GuestUser = z.infer<typeof GuestUserSchema>;
export type RoomState = z.infer<typeof RoomStateSchema>;
export type TurnState = z.infer<typeof TurnStateSchema>;
export type GuessResult = z.infer<typeof GuessResultSchema>;
export type GameWon = z.infer<typeof GameWonSchema>;
export type GameForfeit = z.infer<typeof GameForfeitSchema>;
export type ErrorPayload = z.infer<typeof ErrorPayloadSchema>;

export type ClientToServerSchemaMap = typeof ClientToServerSchemas;
export type ServerToClientSchemaMap = typeof ServerToClientSchemas;

export type ClientEventName = keyof ClientToServerSchemaMap;
export type ServerEventName = keyof ServerToClientSchemaMap;

export type EventPayload<
  TMap extends Record<string, z.ZodTypeAny>,
  TKey extends keyof TMap
> = z.infer<TMap[TKey]>;

export function validateClientPayload<TKey extends ClientEventName>(
  eventName: TKey,
  payload: unknown
): z.ZodSafeParseResult<EventPayload<ClientToServerSchemaMap, TKey>> {
  return ClientToServerSchemas[eventName].safeParse(
    payload
  ) as z.ZodSafeParseResult<EventPayload<ClientToServerSchemaMap, TKey>>;
}

export function validateServerPayload<TKey extends ServerEventName>(
  eventName: TKey,
  payload: unknown
): z.ZodSafeParseResult<EventPayload<ServerToClientSchemaMap, TKey>> {
  return ServerToClientSchemas[eventName].safeParse(
    payload
  ) as z.ZodSafeParseResult<EventPayload<ServerToClientSchemaMap, TKey>>;
}
