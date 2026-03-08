"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { validateServerPayload, type GameWon, type GuessResult, type RoomState } from "@word-hunt/shared";
import { GuestNameModal } from "@/components/GuestNameModal";
import { createGuestIdentity, readGuestIdentity, saveGuestIdentity, type GuestIdentity } from "@/lib/guest";
import { getSocket } from "@/lib/socket";

type Direction = "first" | "closer" | "farther" | "same";
type Proximity = "cold" | "warm" | "hot" | "very-close";
type FeedbackKind = "closer" | "farther" | "very-close" | "cold" | "neutral" | "error";

type GuessEntry = GuessResult & {
  direction: Direction;
  proximity: Proximity;
  timeLabel: string;
};

type FeedbackToast = {
  kind: FeedbackKind;
  title: string;
  detail: string;
};

const RADAR_MAX_RANK = 100_000;
const CONFETTI_COUNT = 18;

function isCompactViewport(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return window.matchMedia("(max-width: 680px)").matches;
}

function toTimeLabel(epochMs: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(epochMs));
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

function directionFrom(previousRank: number | null, currentRank: number): Direction {
  if (previousRank === null) {
    return "first";
  }
  if (currentRank < previousRank) {
    return "closer";
  }
  if (currentRank > previousRank) {
    return "farther";
  }
  return "same";
}

function feedbackFromGuess(guess: GuessEntry): FeedbackToast {
  if (guess.proximity === "very-close") {
    return {
      kind: "very-close",
      title: "Very Close",
      detail: `Rank #${guess.rank}. One more sharp guess.`
    };
  }

  if (guess.direction === "closer") {
    return {
      kind: "closer",
      title: "Closer",
      detail: `Rank improved to #${guess.rank}.`
    };
  }

  if (guess.direction === "farther") {
    return {
      kind: "farther",
      title: "Farther",
      detail: `Rank is now #${guess.rank}. Pivot your semantic direction.`
    };
  }

  if (guess.proximity === "cold") {
    return {
      kind: "cold",
      title: "Cold",
      detail: `Rank #${guess.rank}. Try a closer synonym.`
    };
  }

  return {
    kind: "neutral",
    title: "Locked",
    detail: `Rank #${guess.rank}. Keep hunting inward.`
  };
}

function hashWord(word: string): number {
  let hash = 0;
  for (let i = 0; i < word.length; i += 1) {
    hash = (hash * 31 + word.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function createAmbientParticles(seedText: string, count: number): Array<{
  id: string;
  angle: number;
  radius: number;
  size: number;
  delay: number;
  duration: number;
}> {
  const base = hashWord(seedText || "radar");
  return Array.from({ length: count }, (_, index) => {
    const value = Math.abs(Math.sin(base * 0.0013 + index * 0.9347));
    const value2 = Math.abs(Math.sin(base * 0.0021 + index * 1.531));
    const value3 = Math.abs(Math.sin(base * 0.0008 + index * 2.117));
    return {
      id: `p-${index}`,
      angle: Math.round(value * 360),
      radius: 20 + Math.round(value2 * 74),
      size: 2 + Math.round(value3 * 3),
      delay: Number((value2 * 2.2).toFixed(2)),
      duration: Number((1.8 + value * 2.6).toFixed(2))
    };
  });
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
  return "rgb(196 51 51 / 0.8)";
}

function errorMessageForGuess(code: string, attemptedWord: string): string | null {
  if (code === "WORD_NOT_IN_DICTIONARY") {
    return /(ing|ed|es|s)$/u.test(attemptedWord)
      ? "Try the base form of the word"
      : "Not in dictionary";
  }

  if (code === "INVALID_WORD_FORMAT") {
    return "Use a single common English word";
  }

  if (code === "NOT_YOUR_TURN") {
    return "Wait for your turn pulse.";
  }

  return null;
}

export function SoloClient() {
  const [guest, setGuest] = useState<GuestIdentity | null>(() => readGuestIdentity());
  const [room, setRoom] = useState<RoomState | null>(null);
  const [guesses, setGuesses] = useState<GuessEntry[]>([]);
  const [gameWon, setGameWon] = useState<GameWon | null>(null);
  const [guessWord, setGuessWord] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<FeedbackToast | null>(null);
  const [isSavingLeaderboard, setIsSavingLeaderboard] = useState(false);
  const [leaderboardSaveError, setLeaderboardSaveError] = useState<string | null>(null);
  const [leaderboardSaved, setLeaderboardSaved] = useState(false);
  const [savePromptOpen, setSavePromptOpen] = useState(false);
  const [showInfo, setShowInfo] = useState(false);

  const requestedStartRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const roomCodeRef = useRef<string | null>(null);
  const anonymousGuestRef = useRef<GuestIdentity | null>(null);
  const errorTimeoutRef = useRef<number | null>(null);
  const feedbackTimeoutRef = useRef<number | null>(null);
  const lastSubmittedGuessRef = useRef("");
  const promptedForSaveRef = useRef(false);
  const canRequestHint = Boolean(
    room &&
      room.status === "in_game" &&
      !gameWon &&
      guesses.length > 0 &&
      room.hintsUsed < 3
  );
  const canRevealWord = Boolean(room && room.status === "in_game" && !gameWon);
  const canSaveLeaderboard = Boolean(gameWon && room?.dailyDate);

  const focusGuessInput = (options?: { force?: boolean; scroll?: boolean }) => {
    if (!options?.force && isCompactViewport()) {
      if (options?.scroll) {
        window.setTimeout(() => {
          inputRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }, 120);
      }
      return;
    }

    window.setTimeout(() => {
      inputRef.current?.focus();
      if (options?.scroll && isCompactViewport()) {
        inputRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }, 0);
  };

  const clearTransientError = () => {
    if (errorTimeoutRef.current !== null) {
      window.clearTimeout(errorTimeoutRef.current);
      errorTimeoutRef.current = null;
    }
  };

  const showTransientError = (message: string, ms = 2200) => {
    clearTransientError();
    setError(message);
    errorTimeoutRef.current = window.setTimeout(() => {
      setError(null);
      errorTimeoutRef.current = null;
    }, ms);
  };

  const clearFeedback = () => {
    if (feedbackTimeoutRef.current !== null) {
      window.clearTimeout(feedbackTimeoutRef.current);
      feedbackTimeoutRef.current = null;
    }
  };

  const showFeedback = (next: FeedbackToast) => {
    clearFeedback();
    setFeedback(next);
    feedbackTimeoutRef.current = window.setTimeout(() => {
      setFeedback(null);
      feedbackTimeoutRef.current = null;
    }, 1800);
  };

  useEffect(() => {
    const socket = getSocket();

    const onConnect = () => {
      if (roomCodeRef.current) {
        const currentIdentity = guest ?? anonymousGuestRef.current;
        if (!currentIdentity) {
          return;
        }
        socket.emit("room:join", { roomCode: roomCodeRef.current, user: currentIdentity });
        socket.emit("room:requestState", { roomCode: roomCodeRef.current });
        return;
      }

      if (requestedStartRef.current) {
        return;
      }
      requestedStartRef.current = true;
      socket.emit("solo:startDaily", guest ? { user: guest } : {});
    };

    const onRoomState = (raw: unknown) => {
      const parsed = validateServerPayload("room:state", raw);
      if (parsed.success) {
        const roomChanged = parsed.data.roomCode !== roomCodeRef.current;
        if (!guest && parsed.data.mode === "solo") {
          const anonymousPlayer = parsed.data.players.find((player) => player.teamId === "SOLO");
          if (anonymousPlayer) {
            anonymousGuestRef.current = {
              id: anonymousPlayer.id,
              displayName: anonymousPlayer.displayName
            };
          }
        }
        setRoom(parsed.data);
        roomCodeRef.current = parsed.data.roomCode;

        if (roomChanged) {
          setGuesses([]);
          setGameWon(null);
          setFeedback(null);
        }

        clearTransientError();
        setError(null);

        focusGuessInput({ scroll: true });
      }
    };

    const onTurnState = (raw: unknown) => {
      const parsed = validateServerPayload("turn:state", raw);
      if (parsed.success) {
        focusGuessInput({ scroll: true });
      }
    };

    const onGuess = (raw: unknown) => {
      const parsed = validateServerPayload("guess:result", raw);
      if (!parsed.success) {
        return;
      }

      if (parsed.data.isDuplicate) {
        showTransientError("Already guessed");
        return;
      }

      clearTransientError();
      setError(null);

      setGuesses((previous) => {
        const alreadyAdded = previous.some((entry) => entry.word === parsed.data.word);
        if (alreadyAdded) {
          return previous;
        }

        const previousGuess = previous.at(-1) ?? null;
        const direction = directionFrom(previousGuess?.rank ?? null, parsed.data.rank);
        const entry: GuessEntry = {
          ...parsed.data,
          direction,
          proximity: getProximity(parsed.data.rank),
          timeLabel: toTimeLabel(parsed.data.createdAt)
        };

        showFeedback(feedbackFromGuess(entry));
        return [...previous, entry];
      });
    };

    const onGameWon = (raw: unknown) => {
      const parsed = validateServerPayload("game:won", raw);
      if (parsed.success) {
        setGameWon(parsed.data);
        showFeedback({
          kind: "closer",
          title: "Target Captured",
          detail: `${parsed.data.turns} guesses in ${Math.round(parsed.data.durationMs / 1000)}s.`
        });
      }
    };

    const onSoloReveal = (raw: unknown) => {
      const parsed = validateServerPayload("solo:reveal", raw);
      if (!parsed.success) {
        return;
      }

      showFeedback({
        kind: "neutral",
        title: "Target Word",
        detail: parsed.data.word
      });
    };

    const onError = (raw: unknown) => {
      const parsed = validateServerPayload("error", raw);
      if (!parsed.success) {
        return;
      }

      if (parsed.data.code === "WORD_NOT_IN_DICTIONARY") {
        showTransientError(errorMessageForGuess(parsed.data.code, lastSubmittedGuessRef.current) ?? parsed.data.message);
        return;
      }

      if (parsed.data.code === "INVALID_WORD_FORMAT" || parsed.data.code === "NOT_YOUR_TURN") {
        showTransientError(errorMessageForGuess(parsed.data.code, lastSubmittedGuessRef.current) ?? parsed.data.message);
        return;
      }

      setError(parsed.data.message);
    };

    const onConnectError = () => {
      clearTransientError();
      setError("Realtime connection failed. Retrying...");
    };

    const onDisconnect = () => {
      if (!roomCodeRef.current) {
        requestedStartRef.current = false;
      }
    };

    socket.on("connect", onConnect);
    socket.on("room:state", onRoomState);
    socket.on("turn:state", onTurnState);
    socket.on("guess:result", onGuess);
    socket.on("solo:reveal", onSoloReveal);
    socket.on("game:won", onGameWon);
    socket.on("error", onError);
    socket.on("connect_error", onConnectError);
    socket.on("disconnect", onDisconnect);

    if (!socket.connected) {
      socket.connect();
    } else {
      onConnect();
    }

    return () => {
      clearTransientError();
      clearFeedback();
      socket.off("connect", onConnect);
      socket.off("room:state", onRoomState);
      socket.off("turn:state", onTurnState);
      socket.off("guess:result", onGuess);
      socket.off("solo:reveal", onSoloReveal);
      socket.off("game:won", onGameWon);
      socket.off("error", onError);
      socket.off("connect_error", onConnectError);
      socket.off("disconnect", onDisconnect);
    };
  }, [guest]);

  useEffect(() => {
    const onPageHide = () => {
      const socket = getSocket();
      if (roomCodeRef.current && socket.connected) {
        socket.emit("room:leave", {});
      }
    };

    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
    };
  }, []);

  const guessCount = guesses.length;
  const bestGuess = useMemo(() => {
    return guesses.reduce<GuessEntry | null>((best, guess) => {
      if (!best || guess.rank < best.rank) {
        return guess;
      }
      return best;
    }, null);
  }, [guesses]);
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

  const ambientParticles = useMemo(() => {
    return createAmbientParticles(room?.roomCode ?? "solo", 20);
  }, [room?.roomCode]);

  const requestNewGame = () => {
    const socket = getSocket();
    const previousRoomCode = roomCodeRef.current;

    clearTransientError();
    clearFeedback();
    setError(null);
    setFeedback(null);
    setGuessWord("");
    setGameWon(null);
    setGuesses([]);
    setRoom(null);
    setLeaderboardSaveError(null);
    setLeaderboardSaved(false);
    setSavePromptOpen(false);
    promptedForSaveRef.current = false;
    roomCodeRef.current = null;

    if (previousRoomCode && socket.connected) {
      socket.emit("room:leave", {});
    }

    if (!socket.connected) {
      requestedStartRef.current = false;
      socket.connect();
      return;
    }

    requestedStartRef.current = true;
    socket.emit("solo:startDaily", guest ? { user: guest } : {});
  };

  const requestHint = () => {
    if (!canRequestHint || !room) {
      return;
    }

    getSocket().emit("solo:hint", { roomCode: room.roomCode });
  };

  const requestRevealWord = () => {
    if (!canRevealWord || !room) {
      return;
    }

    getSocket().emit("solo:reveal", { roomCode: room.roomCode });
  };

  const submitGuess = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const word = guessWord.trim().toLowerCase();
    if (!word || !room || room.status !== "in_game") {
      return;
    }

    lastSubmittedGuessRef.current = word;
    getSocket().emit("turn:guess", { roomCode: room.roomCode, word });
    setGuessWord("");
  };

  const saveLeaderboardResult = async (displayName: string) => {
    if (!gameWon || !room?.dailyDate) {
      return;
    }

    const identity = guest ?? createGuestIdentity(displayName);

    saveGuestIdentity(identity);
    setGuest(identity);
    setIsSavingLeaderboard(true);
    setLeaderboardSaveError(null);

    try {
      const response = await fetch("/api/leaderboard/daily-solo", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          date: room.dailyDate,
          userId: identity.id,
          displayName: identity.displayName,
          turnsToSolve: gameWon.turns,
          timeMs: gameWon.durationMs
        })
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Could not save leaderboard result");
      }

      setLeaderboardSaved(true);
      setSavePromptOpen(false);
    } catch (saveError) {
      setLeaderboardSaveError(
        saveError instanceof Error ? saveError.message : "Could not save leaderboard result"
      );
    } finally {
      setIsSavingLeaderboard(false);
    }
  };

  useEffect(() => {
    if (!canSaveLeaderboard || guest || leaderboardSaved || promptedForSaveRef.current) {
      return;
    }

    promptedForSaveRef.current = true;
    setSavePromptOpen(true);
  }, [canSaveLeaderboard, guest, leaderboardSaved]);

  return (
    <>
      {savePromptOpen && canSaveLeaderboard && !leaderboardSaved ? (
        <GuestNameModal
          initialName={guest?.displayName ?? ""}
          title="Save your solo result"
          description="Enter a guest name to add this run to the daily leaderboard."
          submitLabel={isSavingLeaderboard ? "Saving..." : "Save result"}
          cancelLabel="Skip"
          autoFocus
          onCancel={() => setSavePromptOpen(false)}
          onSave={saveLeaderboardResult}
        />
      ) : null}

      <section className="solo-flow">
        <header className="solo-topbar">
          <Link href="/" className="logo-lockup solo-logo" aria-label="Word Sonar home">
            <span className="logo-radar-dot" />
            <span className="logo-text">WORD SONAR</span>
          </Link>

          <div className="solo-topbar-actions">
            <button
              type="button"
              className={`solo-icon-button ${showInfo ? "is-active" : ""}`}
              onClick={() => setShowInfo((current) => !current)}
              aria-label="Show instructions"
              title="How to play"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 10v6" />
                <path d="M12 7h.01" />
              </svg>
            </button>
            <button
              type="button"
              className="solo-icon-button"
              onClick={requestNewGame}
              aria-label="Start a new game"
              title="New game"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M20 12a8 8 0 1 1-2.34-5.66" />
                <path d="M20 4v6h-6" />
              </svg>
            </button>
            <button
              type="button"
              className="solo-icon-button"
              onClick={requestRevealWord}
              aria-label="Show the target word"
              title="Show word"
              disabled={!canRevealWord}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
            <button
              type="button"
              className="solo-icon-button"
              onClick={requestHint}
              aria-label="Show a hint"
              title={
                room?.hintsUsed && room.hintsUsed >= 3
                  ? "All 3 hints used"
                  : canRequestHint
                    ? "Hint"
                    : "Make a guess first"
              }
              disabled={!canRequestHint}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M9 18h6" />
                <path d="M10 22h4" />
                <path d="M8 14c-1.33-1-2-2.33-2-4a6 6 0 1 1 12 0c0 1.67-.67 3-2 4-.8.6-1.32 1.2-1.56 2H9.56C9.32 15.2 8.8 14.6 8 14Z" />
              </svg>
            </button>
          </div>
        </header>

        <section className="solo-signal">
          {showInfo ? (
            <div className="solo-info-popover" role="note">
              <h2 className="solo-info-title">Find the hidden word</h2>
              <p className="muted">
                Guess a common English word. The radar gets stronger when your guess is semantically closer.
              </p>
              <p className="muted">Your goal is to find the exact hidden word.</p>
            </div>
          ) : null}

          <div className="solo-radar-block">
            <div className="home-radar solo-radar-surface" role="img" aria-label="Radar showing semantic distance of guesses">
              <div className="home-radar-ring r1" />
              <div className="home-radar-ring r2" />
              <div className="home-radar-ring r3" />
              <div className="home-radar-sweep" />

              {radarBlips.map((blip) => (
                <span
                  key={blip.key}
                  className={`radar-blip ${blip.proximity}`}
                  style={{
                    top: `${blip.top}%`,
                    left: `${blip.left}%`,
                    ["--blip-delay" as string]: blip.delay
                  }}
                  aria-label={`${blip.word} rank ${blip.rank}`}
                  title={blip.word}
                />
              ))}

              <span className="radar-center-dot" />
            </div>
          </div>

          <div className="solo-progress-grid">
            <div className="solo-progress-item">
              <span className="solo-count-label">Guesses</span>
              <span className="solo-count-value">{guessCount}</span>
            </div>
            <div className="solo-progress-item">
              <span className="solo-count-label">Closest guess so far</span>
              <span className="solo-progress-value">
                {bestGuess ? `${bestGuess.word} (#${bestGuess.rank})` : "No signal yet"}
              </span>
            </div>
          </div>

          {feedback ? (
            <div className={`toast toast-${feedback.kind}`} role="status" aria-live="polite">
              <strong>{feedback.title}</strong>
              <span>{feedback.detail}</span>
            </div>
          ) : null}

          {error ? (
            <div className="toast toast-error" role="status" aria-live="polite">
              <strong>Notice</strong>
              <span>{error}</span>
            </div>
          ) : null}
        </section>

        <div className="solo-input-block">
          <form onSubmit={submitGuess} className="solo-input-form guess-submit-form">
            <input
              ref={inputRef}
              value={guessWord}
              onChange={(event) => setGuessWord(event.target.value)}
              onFocus={() => {
                if (isCompactViewport()) {
                  window.setTimeout(() => {
                    inputRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
                  }, 120);
                }
              }}
              placeholder="Enter a guess"
              disabled={Boolean(gameWon) || room?.status !== "in_game"}
              className="solo-input"
              aria-label="Guess word"
              autoCapitalize="none"
              autoCorrect="off"
              enterKeyHint="go"
              spellCheck={false}
            />
            <button
              type="submit"
              className="button primary big solo-submit guess-submit-button"
              disabled={!guessWord.trim() || Boolean(gameWon) || room?.status !== "in_game"}
            >
              Enter
            </button>
          </form>
          <div className="solo-validation-hints" aria-live="polite">
            <p className="muted small-copy">Common English single words only. Use the base form when possible.</p>
          </div>
        </div>

        <section className="solo-history">
          <div className="solo-history-head">
            <span className="solo-count-label">Guess history</span>
          </div>
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
                <span className="rank">#{guess.rank}</span>
              </article>
            ))}

            {sortedGuesses.length === 0 ? (
              <p className="muted">Enter your first guess to start tracking the hidden word.</p>
            ) : null}
          </div>
        </section>
      </section>

      {gameWon ? (
        <div className="solo-win-overlay" role="dialog" aria-modal="true" aria-labelledby="solo-win-title">
          <div className="solo-confetti" aria-hidden="true">
            {Array.from({ length: CONFETTI_COUNT }, (_, index) => (
              <span
                key={`confetti-${index}`}
                className="solo-confetti-piece"
                style={
                  {
                    "--confetti-left": `${(index / CONFETTI_COUNT) * 100}%`,
                    "--confetti-delay": `${(index % 6) * 0.08}s`,
                    "--confetti-duration": `${2.2 + (index % 5) * 0.16}s`
                  } as CSSProperties
                }
              />
            ))}
          </div>

          <div className="solo-win-modal">
            <p className="solo-win-kicker">Mission complete</p>
            <h2 id="solo-win-title">Congratulations. You&apos;re a winner.</h2>
            <p>
              You guessed <strong>{gameWon.winningWord}</strong> in{" "}
              <strong>{gameWon.turns}</strong> guesses.
            </p>
            {canSaveLeaderboard && !guest && !leaderboardSaved ? (
              <button
                type="button"
                className="button secondary"
                onClick={() => setSavePromptOpen(true)}
                disabled={isSavingLeaderboard}
              >
                Save to leaderboard
              </button>
            ) : null}
            {leaderboardSaved ? (
              <p className="success-copy">Saved to the daily leaderboard as {guest?.displayName}.</p>
            ) : null}
            {leaderboardSaveError ? <p className="error">{leaderboardSaveError}</p> : null}
            <button type="button" className="button primary" onClick={requestNewGame}>
              Start New Game
            </button>
          </div>
        </div>
      ) : null}

    </>
  );
}
