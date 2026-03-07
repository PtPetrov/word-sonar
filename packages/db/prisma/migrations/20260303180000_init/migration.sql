CREATE TYPE "MatchMode" AS ENUM ('solo', 'coop', 'one_v_one', 'three_v_three');
CREATE TYPE "MatchStatus" AS ENUM ('active', 'finished', 'aborted');
CREATE TYPE "RoomStatus" AS ENUM ('forming', 'countdown', 'in_game', 'finished', 'aborted');

CREATE TABLE "users" (
  "id" UUID PRIMARY KEY,
  "display_name" VARCHAR(20) NOT NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "rooms" (
  "code" VARCHAR(6) PRIMARY KEY,
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by_user_id" UUID NOT NULL,
  "status" "RoomStatus" NOT NULL,
  "mode" "MatchMode" NOT NULL,
  CONSTRAINT "rooms_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "matches" (
  "id" UUID PRIMARY KEY,
  "mode" "MatchMode" NOT NULL,
  "dictionary_version" TEXT NOT NULL,
  "target_word" TEXT NOT NULL,
  "turn_ms" INTEGER NOT NULL,
  "started_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ended_at" TIMESTAMP,
  "winner_team_id" TEXT,
  "status" "MatchStatus" NOT NULL,
  "daily_date" DATE
);

CREATE TABLE "match_players" (
  "match_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "team_id" TEXT NOT NULL,
  "is_host" BOOLEAN NOT NULL DEFAULT false,
  "joined_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("match_id", "user_id"),
  CONSTRAINT "match_players_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "match_players_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "guesses" (
  "id" UUID PRIMARY KEY,
  "match_id" UUID NOT NULL,
  "turn_number" INTEGER NOT NULL,
  "user_id" UUID NOT NULL,
  "team_id" TEXT NOT NULL,
  "word" TEXT NOT NULL,
  "rank" INTEGER NOT NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "guesses_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "guesses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "leaderboard_daily_solo" (
  "date" DATE NOT NULL,
  "user_id" UUID NOT NULL,
  "turns_to_solve" INTEGER NOT NULL,
  "time_ms" INTEGER NOT NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("date", "user_id"),
  CONSTRAINT "leaderboard_daily_solo_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "rooms_created_at_idx" ON "rooms"("created_at");
CREATE INDEX "matches_started_at_idx" ON "matches"("started_at");
CREATE INDEX "matches_daily_date_idx" ON "matches"("daily_date");
CREATE INDEX "match_players_user_id_idx" ON "match_players"("user_id");
CREATE INDEX "guesses_match_id_created_at_idx" ON "guesses"("match_id", "created_at");
CREATE INDEX "guesses_match_id_turn_number_idx" ON "guesses"("match_id", "turn_number");
CREATE INDEX "leaderboard_daily_solo_date_turns_to_solve_time_ms_idx" ON "leaderboard_daily_solo"("date", "turns_to_solve", "time_ms");
