"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { DISPLAY_NAME_REGEX, validateServerPayload, type GuestUser } from "@word-hunt/shared";
import { createGuestIdentity, readGuestIdentity, saveGuestIdentity, type GuestIdentity } from "@/lib/guest";
import { getSocket } from "@/lib/socket";

function normalizeJoinCode(value: string): string {
  return value.replace(/\D/g, "").slice(0, 4);
}

export function LobbyClient() {
  const router = useRouter();
  const [guest, setGuest] = useState<GuestIdentity | null>(null);
  const [nameDraft, setNameDraft] = useState(() => readGuestIdentity()?.displayName ?? "");
  const [editingName, setEditingName] = useState(true);
  const [joinCode, setJoinCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const socket = getSocket();

    const onError = (raw: unknown) => {
      const parsed = validateServerPayload("error", raw);
      if (!parsed.success) {
        return;
      }

      setBusy(false);
      setError(parsed.data.message);
    };

    const onCreated = (raw: unknown) => {
      const parsed = validateServerPayload("lobby:created", raw);
      if (!parsed.success) {
        return;
      }

      setBusy(false);
      setError(null);
      router.push(`/room/${parsed.data.roomCode}?team=A`);
    };

    socket.on("error", onError);
    socket.on("lobby:created", onCreated);

    return () => {
      socket.off("error", onError);
      socket.off("lobby:created", onCreated);
    };
  }, [router]);

  const canContinue = useMemo(() => {
    return DISPLAY_NAME_REGEX.test(nameDraft.trim());
  }, [nameDraft]);

  const saveName = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = nameDraft.trim();
    if (!DISPLAY_NAME_REGEX.test(trimmed)) {
      setError("Use 2-20 chars with letters, numbers, space, _ or -.");
      return;
    }

    const nextIdentity: GuestUser = createGuestIdentity(trimmed);

    saveGuestIdentity(nextIdentity);
    setGuest(nextIdentity);
    setEditingName(false);
    setError(null);
  };

  const createArena = () => {
    if (!guest) {
      setEditingName(true);
      return;
    }

    const socket = getSocket();
    if (!socket.connected) {
      socket.connect();
    }

    setBusy(true);
    setError(null);
    socket.emit("lobby:createVersus", { mode: "1v1", user: guest, turnMs: 20_000 });
  };

  const joinArena = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!guest) {
      setEditingName(true);
      return;
    }

    const normalized = normalizeJoinCode(joinCode);
    if (normalized.length !== 4) {
      setError("Enter a 4 digit arena code.");
      return;
    }

    setError(null);
    router.push(`/room/${normalized}?team=B`);
  };

  return (
    <section className="lobby-shell">
      <header className="solo-topbar">
        <Link href="/" className="logo-lockup solo-logo" aria-label="Word Sonar home">
          <span className="logo-radar-dot" />
          <span className="logo-text">WORD SONAR</span>
        </Link>
      </header>

      <div className="lobby-flow">
        <div className="lobby-copy">
          <p className="solo-count-label">Lobby</p>
          {editingName ? (
            <>
              <h1 className="big lobby-title">Set your name and enter the arena.</h1>
              <p className="muted">Create a 1v1 code for a friend or join one with a 4 digit arena code.</p>
            </>
          ) : (
            <>
              <h1 className="big lobby-title">Playing as {guest?.displayName}</h1>
              <p className="muted">Create a 1v1 code for a friend or join one with a 4 digit arena code.</p>
            </>
          )}
        </div>

        {editingName ? (
          <form className="lobby-name-form" onSubmit={saveName}>
            <input
              value={nameDraft}
              onChange={(event) => setNameDraft(event.target.value)}
              placeholder="Your name"
              maxLength={20}
              autoFocus
              aria-label="Your name"
            />
            <button type="submit" className="button primary big lobby-primary-action" disabled={!canContinue}>
              Continue
            </button>
          </form>
        ) : (
          <div className="lobby-identity">
            <button type="button" className="solo-text-button" onClick={() => setEditingName(true)}>
              Change name
            </button>
          </div>
        )}

        {guest && !editingName ? (
          <div className="lobby-actions">
            <button
              type="button"
              className="button primary big lobby-primary-action"
              onClick={createArena}
              disabled={busy}
            >
              Create arena
            </button>

            <p className="lobby-divider">OR</p>

            <form className="lobby-join-form" onSubmit={joinArena}>
              <input
                value={joinCode}
                onChange={(event) => setJoinCode(normalizeJoinCode(event.target.value))}
                inputMode="numeric"
                pattern="[0-9]{4}"
                maxLength={4}
                placeholder="0000"
                aria-label="Arena code"
              />
              <button type="submit" className="button primary big lobby-primary-action">
                Join arena
              </button>
            </form>
          </div>
        ) : null}

        {error ? <p className="error">{error}</p> : null}
      </div>
    </section>
  );
}
