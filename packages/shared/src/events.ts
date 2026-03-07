import type { z } from "zod";
import type {
  ClientToServerSchemaMap,
  ServerToClientSchemaMap
} from "./schemas.js";

export type ClientPayload<TKey extends keyof ClientToServerSchemaMap> = z.infer<
  ClientToServerSchemaMap[TKey]
>;

export type ServerPayload<TKey extends keyof ServerToClientSchemaMap> = z.infer<
  ServerToClientSchemaMap[TKey]
>;

export interface ClientToServerEvents {
  "room:join": (payload: ClientPayload<"room:join">) => void;
  "room:leave": (payload: ClientPayload<"room:leave">) => void;
  "room:requestState": (payload: ClientPayload<"room:requestState">) => void;
  "lobby:createVersus": (payload: ClientPayload<"lobby:createVersus">) => void;
  "lobby:createCoop": (payload: ClientPayload<"lobby:createCoop">) => void;
  "lobby:createTeam": (payload: ClientPayload<"lobby:createTeam">) => void;
  "lobby:joinTeam": (payload: ClientPayload<"lobby:joinTeam">) => void;
  "solo:startDaily": (payload: ClientPayload<"solo:startDaily">) => void;
  "solo:hint": (payload: ClientPayload<"solo:hint">) => void;
  "solo:reveal": (payload: ClientPayload<"solo:reveal">) => void;
  "game:start": (payload: ClientPayload<"game:start">) => void;
  "arena:giveUp": (payload: ClientPayload<"arena:giveUp">) => void;
  "arena:restart": (payload: ClientPayload<"arena:restart">) => void;
  "turn:guess": (payload: ClientPayload<"turn:guess">) => void;
  "turn:pass": (payload: ClientPayload<"turn:pass">) => void;
}

export interface ServerToClientEvents {
  error: (payload: ServerPayload<"error">) => void;
  "lobby:created": (payload: ServerPayload<"lobby:created">) => void;
  "lobby:countdown": (payload: ServerPayload<"lobby:countdown">) => void;
  "room:state": (payload: ServerPayload<"room:state">) => void;
  "game:started": (payload: ServerPayload<"game:started">) => void;
  "turn:state": (payload: ServerPayload<"turn:state">) => void;
  "guess:result": (payload: ServerPayload<"guess:result">) => void;
  "solo:hint": (payload: ServerPayload<"solo:hint">) => void;
  "solo:reveal": (payload: ServerPayload<"solo:reveal">) => void;
  "game:won": (payload: ServerPayload<"game:won">) => void;
  "game:forfeit": (payload: ServerPayload<"game:forfeit">) => void;
  "leaderboard:dailySolo": (payload: ServerPayload<"leaderboard:dailySolo">) => void;
}

export interface InterServerEvents {
  noop: () => void;
}

export interface SocketData {
  userId?: string;
  roomCode?: string;
}
