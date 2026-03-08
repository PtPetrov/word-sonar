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
  return "rgb(226 71 144 / 0.8)";
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
  const [guessWord, setGuessWord] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const inputRef = useRef<HTMLInputElement | null>(null);
  const errorTimeoutRef = useRef<number | null>(null);

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

      setGameForfeit(null);
      setGameWon(parsed.data);
    };

    const onGameForfeit = (raw: unknown) => {
      const parsed = validateServerPayload("game:forfeit", raw);
      if (!parsed.success) {
        return;
      }

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
    getSocket().emit("arena:giveUp", { roomCode: room.roomCode });
  };

  const requestRestart = () => {
    if (!room) {
      return;
    }

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
          }}
        />
      ) : null}

      {showGiveUpConfirm ? (
        <div className="solo-win-overlay" role="dialog" aria-modal="true" aria-labelledby="arena-give-up-title">
          <div className="solo-win-modal">
            <p className="solo-win-kicker">Confirm</p>
            <h2 id="arena-give-up-title">Give up this match?</h2>
            <p>This will end the current 1v1 game immediately.</p>
            <div className="inline">
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
              className="button primary big guess-submit-button"
              disabled={!guessWord.trim() || !myTurn || Boolean(gameWon) || room?.status !== "in_game"}
            >
              Enter
            </button>
          </form>
        </div>

        <section className="solo-history">
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
                <span className="rank">{guess.rank}</span>
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
