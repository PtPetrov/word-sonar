"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  validateServerPayload,
  type GameForfeit,
  type GameWon,
  type GuessResult,
  type RoomState,
  type TurnState
} from "@word-hunt/shared";
import { GuestNameModal } from "@/components/GuestNameModal";
import { captureAnalyticsEvent, identifyAnalyticsUser } from "@/lib/analytics";
import { createGuestIdentity, readGuestIdentity, saveGuestIdentity, type GuestIdentity } from "@/lib/guest";
import { getSocket } from "@/lib/socket";

type RoomClientProps = {
  roomCode: string;
  preferredTeam: "A" | "B" | null;
};

type Proximity = "cold" | "warm" | "hot" | "very-close";

const RADAR_MAX_RANK = 100_000;

function hashWord(word: string): number {
  let hash = 0;
  for (let i = 0; i < word.length; i += 1) {
    hash = (hash * 31 + word.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function getProximity(rank: number): Proximity {
  if (rank <= 120) {
    return "very-close";
  }
  if (rank <= 700) {
    return "hot";
  }
  if (rank <= 2500) {
    return "warm";
  }
  return "cold";
}

function proximityChipLabel(proximity: Proximity): string {
  if (proximity === "very-close") {
    return "🥵 Very close";
  }
  if (proximity === "hot") {
    return "🔥 Hot";
  }
  if (proximity === "warm") {
    return "🌡️ Warm";
  }
  return "❄️ Cold";
}

function radarRadiusPercentForRank(rank: number, maxRank: number): number {
  const safeRank = Math.min(Math.max(1, rank), maxRank);

  if (safeRank <= 100) {
    const t = (safeRank - 1) / 99;
    return 3 + t * 10;
  }

  const normalized = (Math.log(safeRank) - Math.log(100)) / (Math.log(maxRank) - Math.log(100));
  return 15 + normalized * 27;
}

function scanDelayForAngle(angle: number, durationSeconds = 7.2): string {
  const normalized = ((angle % 360) + 360) % 360;
  const delay = -((normalized / 360) * durationSeconds);
  return `${delay.toFixed(2)}s`;
}

function historyFillWidth(rank: number, maxRank: number): string {
  const safeRank = Math.min(Math.max(1, rank), maxRank);
  if (safeRank === 1) {
    return "100%";
  }
  if (safeRank === 2) {
    return "95%";
  }
  const closeness = 1 - Math.log(safeRank + 1) / Math.log(maxRank + 1);
  const eased = Math.pow(closeness, 0.42);
  const percent = 8 + eased * 84;
  return `${percent.toFixed(2)}%`;
}

function historyFillColor(proximity: Proximity): string {
  if (proximity === "very-close") {
    return "rgb(132 204 116 / 0.72)";
  }
  if (proximity === "hot") {
    return "rgb(214 137 67 / 0.78)";
  }
  if (proximity === "warm") {
    return "rgb(226 186 92 / 0.72)";
  }
  return "rgb(136 180 255 / 0.68)";
}

type RadarGuess = GuessResult & {
  proximity: Proximity;
};

export function RoomClient({ roomCode, preferredTeam }: RoomClientProps) {
  const [guest, setGuest] = useState<GuestIdentity | null>(() => readGuestIdentity());
  const [needsGuestName, setNeedsGuestName] = useState(() => !readGuestIdentity());
  const [room, setRoom] = useState<RoomState | null>(null);
  const [turn, setTurn] = useState<TurnState | null>(null);
  const [guesses, setGuesses] = useState<RadarGuess[]>([]);
  const [gameWon, setGameWon] = useState<GameWon | null>(null);
  const [gameForfeit, setGameForfeit] = useState<GameForfeit | null>(null);
  const [showGiveUpConfirm, setShowGiveUpConfirm] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [guessWord, setGuessWord] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const inputRef = useRef<HTMLInputElement | null>(null);
  const errorTimeoutRef = useRef<number | null>(null);
  const joinedRoomRef = useRef<string | null>(null);
  const activeMatchRef = useRef<string | null>(null);
  const trackedGuessKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (guest) {
      identifyAnalyticsUser(guest, { surface: "arena" });
    }
  }, [guest]);

  useEffect(() => {
    if (!guest || !/^\d{4}$/u.test(roomCode)) {
      return;
    }

    const socket = getSocket();

    const onConnect = () => {
      if (preferredTeam) {
        socket.emit("lobby:joinTeam", { roomCode, teamId: preferredTeam, user: guest });
      }

      socket.emit("room:join", { roomCode, user: guest });
      socket.emit("room:requestState", { roomCode });
    };

    const onError = (raw: unknown) => {
      const parsed = validateServerPayload("error", raw);
      if (!parsed.success) {
        return;
      }

      if (parsed.data.code === "WORD_NOT_IN_DICTIONARY") {
        setError("I don't know this word.");
      } else if (parsed.data.code === "PROFANITY_NOT_ALLOWED") {
        setError("That word is blocked.");
      } else if (parsed.data.code === "INVALID_WORD_FORMAT") {
        setError("Use one English word.");
      } else if (parsed.data.code === "NOT_YOUR_TURN") {
        setError("Wait for your turn.");
      } else {
        setError(parsed.data.message);
      }

      if (errorTimeoutRef.current !== null) {
        window.clearTimeout(errorTimeoutRef.current);
      }
      errorTimeoutRef.current = window.setTimeout(() => {
        setError(null);
        errorTimeoutRef.current = null;
      }, 2200);
    };

    const onRoomState = (raw: unknown) => {
      const parsed = validateServerPayload("room:state", raw);
      if (!parsed.success) {
        return;
      }

      if (joinedRoomRef.current !== parsed.data.roomCode) {
        joinedRoomRef.current = parsed.data.roomCode;
        captureAnalyticsEvent("arena_joined", {
          room_code: parsed.data.roomCode,
          mode: parsed.data.mode,
          preferred_team: preferredTeam ?? "none"
        });
      }

      if (parsed.data.matchId && activeMatchRef.current !== parsed.data.matchId) {
        activeMatchRef.current = parsed.data.matchId;
        trackedGuessKeysRef.current.clear();
        captureAnalyticsEvent("arena_game_started", {
          room_code: parsed.data.roomCode,
          match_id: parsed.data.matchId,
          mode: parsed.data.mode
        });
      }

      setRoom(parsed.data);
      if (parsed.data.status !== "finished") {
        setGameWon(null);
        setGameForfeit(null);
      }
      window.setTimeout(() => {
        inputRef.current?.focus();
      }, 0);
    };

    const onTurnState = (raw: unknown) => {
      const parsed = validateServerPayload("turn:state", raw);
      if (!parsed.success) {
        return;
      }

      setTurn(parsed.data);
      window.setTimeout(() => {
        inputRef.current?.focus();
      }, 0);
    };

    const onGuess = (raw: unknown) => {
      const parsed = validateServerPayload("guess:result", raw);
      if (!parsed.success) {
        return;
      }

      const guessKey = `${parsed.data.byUserId}:${parsed.data.word}:${parsed.data.createdAt}`;
      if (parsed.data.byUserId === guest.id && !trackedGuessKeysRef.current.has(guessKey)) {
        trackedGuessKeysRef.current.add(guessKey);
        captureAnalyticsEvent("arena_guess_result", {
          room_code: roomCode,
          rank: parsed.data.rank,
          is_duplicate: parsed.data.isDuplicate,
          is_new_team_best: parsed.data.isNewTeamBest,
          turn_number: parsed.data.turnNumber
        });
      }

      setGuesses((previous) => {
        const exists = previous.some((entry) => {
          return (
            entry.createdAt === parsed.data.createdAt &&
            entry.word === parsed.data.word &&
            entry.byUserId === parsed.data.byUserId
          );
        });
        if (exists) {
          return previous;
        }

        return [...previous, { ...parsed.data, proximity: getProximity(parsed.data.rank) }];
      });
    };

    const onGameWon = (raw: unknown) => {
      const parsed = validateServerPayload("game:won", raw);
      if (!parsed.success) {
        return;
      }

      captureAnalyticsEvent("arena_game_won", {
        room_code: roomCode,
        winner_team: parsed.data.winnerTeamId,
        turns: parsed.data.turns,
        duration_ms: parsed.data.durationMs
      });
      setGameForfeit(null);
      setGameWon(parsed.data);
    };

    const onGameForfeit = (raw: unknown) => {
      const parsed = validateServerPayload("game:forfeit", raw);
      if (!parsed.success) {
        return;
      }

      captureAnalyticsEvent("arena_game_forfeit", {
        room_code: roomCode,
        winner_team: parsed.data.winnerTeamId,
        loser_team: parsed.data.loserTeamId
      });
      setGameWon(null);
      setGameForfeit(parsed.data);
    };

    const onGameStarted = () => {
      setGuesses([]);
      setGuessWord("");
      setGameWon(null);
      setGameForfeit(null);
      setError(null);
    };

    socket.on("connect", onConnect);
    socket.on("error", onError);
    socket.on("room:state", onRoomState);
    socket.on("turn:state", onTurnState);
    socket.on("guess:result", onGuess);
    socket.on("game:won", onGameWon);
    socket.on("game:forfeit", onGameForfeit);
    socket.on("game:started", onGameStarted);

    if (!socket.connected) {
      socket.connect();
    } else {
      onConnect();
    }

    return () => {
      if (errorTimeoutRef.current !== null) {
        window.clearTimeout(errorTimeoutRef.current);
      }

      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.off("room:state", onRoomState);
      socket.off("turn:state", onTurnState);
      socket.off("guess:result", onGuess);
      socket.off("game:won", onGameWon);
      socket.off("game:forfeit", onGameForfeit);
      socket.off("game:started", onGameStarted);
    };
  }, [guest, preferredTeam, roomCode]);

  useEffect(() => {
    const onPageHide = () => {
      const socket = getSocket();
      if (socket.connected) {
        socket.emit("room:leave", {});
      }
    };

    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
    };
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 250);

    return () => window.clearInterval(intervalId);
  }, []);

  const me = useMemo(() => {
    if (!room || !guest) {
      return null;
    }

    return room.players.find((player) => player.id === guest.id) ?? null;
  }, [guest, room]);

  const opponent = useMemo(() => {
    if (!room || !guest) {
      return null;
    }

    return room.players.find((player) => player.id !== guest.id) ?? null;
  }, [guest, room]);

  const activePlayer = useMemo(() => {
    if (!room || !turn) {
      return null;
    }

    return room.players.find((player) => player.id === turn.activePlayerId) ?? null;
  }, [room, turn]);

  const myTurn = Boolean(guest && turn && turn.activePlayerId === guest.id && room?.status === "in_game");
  const waitingForOpponent = room?.status === "forming";
  const turnSecondsLeft = turn?.endsAt ? Math.max(0, Math.ceil((turn.endsAt - nowMs) / 1000)) : null;

  const sortedGuesses = useMemo(() => {
    return [...guesses].sort((a, b) => {
      if (a.rank !== b.rank) {
        return a.rank - b.rank;
      }
      return a.createdAt - b.createdAt;
    });
  }, [guesses]);

  const radarBlips = useMemo(() => {
    const placed: Array<{ x: number; y: number }> = [];

    return guesses.slice(-24).map((guess, index) => {
      const targetRadius = radarRadiusPercentForRank(guess.rank, RADAR_MAX_RANK);
      const angleSeed = (index * 137.5 + (hashWord(guess.word) % 53)) % 360;
      let angle = angleSeed;
      let radius = targetRadius;
      let x = 50;
      let y = 50;

      for (let attempt = 0; attempt < 24; attempt += 1) {
        const radians = (angle * Math.PI) / 180;
        x = 50 + Math.cos(radians) * radius;
        y = 50 + Math.sin(radians) * radius;

        const minDistance = guess.rank <= 100 ? 6.5 : 5;
        const collides = placed.some((point) => Math.hypot(point.x - x, point.y - y) < minDistance);
        if (!collides) {
          break;
        }

        angle = (angleSeed + attempt * 23) % 360;
        radius = Math.min(targetRadius + attempt * 0.55, guess.rank <= 100 ? 13.5 : 42);
      }

      placed.push({ x, y });

      return {
        key: `${guess.word}-${guess.createdAt}`,
        top: y,
        left: x,
        delay: scanDelayForAngle(angle),
        proximity: guess.proximity,
        word: guess.word,
        rank: guess.rank
      };
    });
  }, [guesses]);

  const submitGuess = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const word = guessWord.trim().toLowerCase();
    if (!word || !room || !myTurn) {
      return;
    }

    captureAnalyticsEvent("arena_guess_submitted", {
      room_code: room.roomCode,
      guess_length: word.length,
      turn_number: turn?.turnNumber ?? null
    });
    getSocket().emit("turn:guess", { roomCode: room.roomCode, word });
    setGuessWord("");
  };

  const requestGiveUp = () => {
    if (!room || room.status !== "in_game") {
      return;
    }

    setShowGiveUpConfirm(true);
  };

  const confirmGiveUp = () => {
    if (!room || room.status !== "in_game") {
      return;
    }

    setShowGiveUpConfirm(false);
    captureAnalyticsEvent("arena_give_up_confirmed", { room_code: room.roomCode });
    getSocket().emit("arena:giveUp", { roomCode: room.roomCode });
  };

  const requestRestart = () => {
    if (!room) {
      return;
    }

    captureAnalyticsEvent("arena_restart_requested", { room_code: room.roomCode });
    getSocket().emit("arena:restart", { roomCode: room.roomCode });
  };

  const forfeitWinnerName = useMemo(() => {
    if (!gameForfeit || !room) {
      return null;
    }

    return (
      room.players.find((player) => player.id === gameForfeit.winnerUserId)?.displayName ??
      (gameForfeit.winnerTeamId === "A" ? "Player A" : "Player B")
    );
  }, [gameForfeit, room]);

  const forfeitLoserName = useMemo(() => {
    if (!gameForfeit || !room) {
      return null;
    }

    return (
      room.players.find((player) => player.id === gameForfeit.loserUserId)?.displayName ??
      (gameForfeit.loserTeamId === "A" ? "Player A" : "Player B")
    );
  }, [gameForfeit, room]);

  return (
    <>
      {needsGuestName ? (
        <GuestNameModal
          onSave={(displayName) => {
            const identity = createGuestIdentity(displayName);
            saveGuestIdentity(identity);
            setGuest(identity);
            setNeedsGuestName(false);
            identifyAnalyticsUser(identity, { surface: "arena" });
            captureAnalyticsEvent("guest_name_saved", { surface: "arena" });
          }}
        />
      ) : null}

      {showGiveUpConfirm ? (
        <div className="solo-win-overlay" role="dialog" aria-modal="true" aria-labelledby="arena-give-up-title">
          <div className="solo-win-modal">
            <p className="solo-win-kicker">Confirm</p>
            <h2 id="arena-give-up-title">Give up this match?</h2>
            <p>This will end the current 1v1 game immediately.</p>
            <div className="solo-modal-actions">
              <button type="button" className="button ghost" onClick={() => setShowGiveUpConfirm(false)}>
                Cancel
              </button>
              <button type="button" className="button primary" onClick={confirmGiveUp}>
                Give Up
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showInfo ? (
        <div
          className="solo-win-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="arena-info-title"
          onClick={() => setShowInfo(false)}
        >
          <div
            className="solo-win-modal solo-info-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="solo-info-header">
              <p className="solo-win-kicker">How to play</p>
              <h2 id="arena-info-title">Find the hidden word</h2>
            </div>

            <div className="solo-info-intro">
              <p>Guess a common English word.</p>
              <p>Each guess tells you how close you are in meaning.</p>
            </div>

            <section className="solo-info-section" aria-labelledby="arena-info-how-it-works">
              <h3 id="arena-info-how-it-works" className="solo-info-section-title">
                How it works
              </h3>
              <ol className="solo-info-steps">
                <li className="solo-info-step">
                  <strong>Guess a word</strong>
                  <span>Start with any common English word.</span>
                </li>
                <li className="solo-info-step">
                  <strong>Read the signal</strong>
                  <span>A stronger signal means you&apos;re closer in meaning.</span>
                </li>
                <li className="solo-info-step">
                  <strong>Find the exact word</strong>
                  <span>Reach rank #1 to solve it.</span>
                </li>
              </ol>
            </section>

            <section className="solo-info-section" aria-labelledby="arena-info-closeness">
              <h3 id="arena-info-closeness" className="solo-info-section-title">
                How close you are
              </h3>
              <div className="solo-info-bands">
                <div className="solo-info-band very-close">🥵 Very close — #1–120</div>
                <div className="solo-info-band hot">🔥 Hot — #121–700</div>
                <div className="solo-info-band warm">🌡️ Warm — #701–2500</div>
                <div className="solo-info-band cold">❄️ Cold — #2501+</div>
              </div>
            </section>

            <section className="solo-info-section" aria-labelledby="arena-info-compare">
              <h3 id="arena-info-compare" className="solo-info-section-title">
                How your guesses compare
              </h3>
              <div className="solo-info-compare">
                <div className="solo-info-compare-row">
                  <strong>🏆 Best so far</strong>
                  <span>your closest guess yet</span>
                </div>
                <div className="solo-info-compare-row">
                  <strong>🥵 Warmer</strong>
                  <span>better than your previous guess</span>
                </div>
                <div className="solo-info-compare-row">
                  <strong>🥶 Colder</strong>
                  <span>worse than your previous guess</span>
                </div>
              </div>
            </section>

            <p className="solo-info-tip">Tip: Start broad, then narrow in.</p>

            <button
              type="button"
              className="button primary"
              onClick={() => setShowInfo(false)}
            >
              Got it
            </button>
          </div>
        </div>
      ) : null}

      <section className="solo-flow arena-flow">
        <header className="solo-topbar">
          <Link href="/" className="logo-lockup solo-logo" aria-label="Word Sonar home">
            <span className="logo-radar-dot" />
            <span className="logo-text">WORD SONAR</span>
          </Link>

          <div className="solo-topbar-actions">
            <button
              type="button"
              className="solo-icon-button solo-give-up-button"
              onClick={requestGiveUp}
              aria-label="Give up"
              title="Give up"
              disabled={room?.status !== "in_game"}
            >
              <span aria-hidden="true">🏳️</span>
            </button>
          </div>
        </header>

        <div className="arena-copy">
          <p className="solo-count-label">Arena {roomCode}</p>
          <div className="arena-scoreline">
            <span className={myTurn ? "active" : ""}>{me?.displayName ?? "You"}</span>
            <span className="arena-scoreline-separator">vs</span>
            <span className={!myTurn && room?.status === "in_game" ? "active" : ""}>
              {opponent?.displayName ?? "Waiting..."}
            </span>
          </div>
          {waitingForOpponent ? (
            <p className="muted">Share code {roomCode} with a friend. The arena starts when both hunters join.</p>
          ) : null}
          {room?.status === "in_game" ? (
            <div className="arena-turnline">
              <span>{myTurn ? "Your turn" : `${activePlayer?.displayName ?? "Opponent"} is up`}</span>
              <strong>{turnSecondsLeft ?? 0}s</strong>
            </div>
          ) : null}
        </div>

        <div className="solo-radar-block">
          <div className="home-radar solo-radar-surface" role="img" aria-label="Radar showing arena guesses">
            <div className="home-radar-ring r1" />
            <div className="home-radar-ring r2" />
            <div className="home-radar-ring r3" />
            <div className="home-radar-sweep" />

            {radarBlips.map((blip) => (
              <span
                key={blip.key}
                className={`radar-blip ${blip.proximity}`}
                style={
                  {
                    top: `${blip.top}%`,
                    left: `${blip.left}%`,
                    "--blip-delay": blip.delay
                  } as CSSProperties
                }
                aria-label={`${blip.word} rank ${blip.rank}`}
                title={blip.word}
              />
            ))}

            <span className="radar-center-dot" />
          </div>
        </div>

        <div className="arena-status-row">
          {room?.status === "in_game" ? (
            <div className="arena-turnline arena-turnline-inline">
              <span>{myTurn ? "Your turn" : `${activePlayer?.displayName ?? "Opponent"} turn`}</span>
              <strong>{turnSecondsLeft ?? 0}s</strong>
            </div>
          ) : null}

          <div className="solo-count">
            <span className="solo-count-label">Guesses:</span>
            <span className="solo-count-value">{guesses.length}</span>
          </div>
        </div>

        <div className="solo-input-block">
          {error ? (
            <div className="toast toast-error" role="status" aria-live="polite">
              <strong>Notice</strong>
              <span>{error}</span>
            </div>
          ) : null}

          <form onSubmit={submitGuess} className="guess-submit-form">
            <input
              ref={inputRef}
              value={guessWord}
              onChange={(event) => setGuessWord(event.target.value)}
              placeholder={
                room?.status !== "in_game"
                  ? "Waiting for the arena to start"
                  : myTurn
                    ? "Type your guess and press Enter"
                    : "Waiting for the other player"
              }
              disabled={!myTurn || Boolean(gameWon) || room?.status !== "in_game"}
              className="solo-input"
              aria-label="Guess word"
            />
            <button
              type="submit"
              className="button primary big solo-submit guess-submit-button"
              disabled={!guessWord.trim() || !myTurn || Boolean(gameWon) || room?.status !== "in_game"}
            >
              Enter
            </button>
          </form>
          <p className="home-rules-preview solo-rules-preview">
            <button
              type="button"
              className={`solo-inline-info-button ${showInfo ? "is-active" : ""}`}
              onClick={() => setShowInfo((current) => !current)}
              aria-label="Show instructions"
              title="How to play"
              aria-pressed={showInfo}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 10v6" />
                <path d="M12 7h.01" />
              </svg>
            </button>{" "}
            Guess a common English word. Each guess shows whether you’re getting
            closer in meaning.
          </p>
        </div>

        <section className="solo-history">
          {sortedGuesses.length > 0 ? (
            <div className="history-best-banner">🏆 Best so far</div>
          ) : null}
          <div className="history-list">
            {sortedGuesses.map((guess) => (
              <article
                key={`${guess.word}-${guess.createdAt}`}
                className="history-row"
                style={
                  {
                    "--history-fill-width": historyFillWidth(guess.rank, RADAR_MAX_RANK),
                    "--history-fill-color": historyFillColor(guess.proximity)
                  } as CSSProperties
                }
              >
                <strong>{guess.word}</strong>
                <div className="history-row-meta">
                  <span className="rank">#{guess.rank}</span>
                  <span className={`history-proximity-chip ${guess.proximity}`}>
                    {proximityChipLabel(guess.proximity)}
                  </span>
                </div>
              </article>
            ))}

            {sortedGuesses.length === 0 ? (
              <p className="muted">
                {waitingForOpponent
                  ? "Arena idle. Wait for the second hunter to lock in."
                  : "Arena live. The first guess will appear here."}
              </p>
            ) : null}
          </div>
        </section>
      </section>

      {gameForfeit ? (
        <div className="solo-win-overlay" role="dialog" aria-modal="true" aria-labelledby="arena-forfeit-title">
          <div className="solo-win-modal">
            <p className="solo-win-kicker">Arena complete</p>
            <h2 id="arena-forfeit-title">{forfeitWinnerName} wins.</h2>
            <p>
              {forfeitLoserName} gave up the hunt.
            </p>
            <button type="button" className="button primary" onClick={requestRestart}>
              Start Another Game
            </button>
          </div>
        </div>
      ) : null}

      {gameWon ? (
        <div className="solo-win-overlay" role="dialog" aria-modal="true" aria-labelledby="arena-win-title">
          <div className="solo-win-modal">
            <p className="solo-win-kicker">Arena complete</p>
            <h2 id="arena-win-title">
              {(room?.players.find((player) => player.teamId === gameWon.winnerTeamId)?.displayName ?? "A hunter")} won.
            </h2>
            <p>
              The word was <strong>{gameWon.winningWord}</strong>.
            </p>
            <Link href="/lobby" className="button primary">
              Back to Lobby
            </Link>
          </div>
        </div>
      ) : null}
    </>
  );
}
