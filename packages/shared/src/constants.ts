export const ROOM_CODE_LENGTH = 4;
export const TURN_MS_DEFAULT = 15_000;
export const COUNTDOWN_SECONDS_DEFAULT = 5;

export const MODE_VALUES = ["solo", "coop", "1v1", "3v3"] as const;
export const ROOM_STATUS_VALUES = [
  "forming",
  "countdown",
  "in_game",
  "finished",
  "aborted"
] as const;

export const TEAM_ID_VALUES = ["A", "B", "COOP", "SOLO"] as const;

export const WORD_REGEX = /^[a-z]+$/;
export const DISPLAY_NAME_REGEX = /^[a-zA-Z0-9 _-]{2,20}$/;

export const MAX_PLAYERS_BY_MODE = {
  solo: 1,
  coop: 8,
  "1v1": 2,
  "3v3": 6
} as const;

export const TEAM_SIZE_BY_MODE = {
  solo: 1,
  coop: 8,
  "1v1": 1,
  "3v3": 3
} as const;
