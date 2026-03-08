"use client";

import { DISPLAY_NAME_REGEX } from "@word-hunt/shared";

const GUEST_KEY = "word_hunt_guest";
const SOLO_PLAYER_KEY = "word_hunt_solo_player";

export type GuestIdentity = {
  id: string;
  displayName: string;
};

export function readGuestIdentity(): GuestIdentity | null {
  return readIdentity(GUEST_KEY);
}

function readIdentity(storageKey: string): GuestIdentity | null {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.localStorage.getItem(storageKey);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as GuestIdentity;
    if (!parsed?.id || !parsed?.displayName) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export function saveGuestIdentity(identity: GuestIdentity): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(GUEST_KEY, JSON.stringify(identity));
  document.cookie = `word_hunt_guest=${identity.id}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

export function ensureSoloPlayerIdentity(): GuestIdentity {
  const guest = readGuestIdentity();
  if (guest) {
    return guest;
  }

  const existingSoloPlayer = readIdentity(SOLO_PLAYER_KEY);
  if (existingSoloPlayer) {
    return existingSoloPlayer;
  }

  const soloPlayer: GuestIdentity = {
    id: crypto.randomUUID(),
    displayName: "Guest"
  };

  if (typeof window !== "undefined") {
    window.localStorage.setItem(SOLO_PLAYER_KEY, JSON.stringify(soloPlayer));
  }

  return soloPlayer;
}

export function createGuestIdentity(displayName: string): GuestIdentity {
  const name = displayName.trim();
  if (!DISPLAY_NAME_REGEX.test(name)) {
    throw new Error("Display name must be 2-20 chars and use letters, numbers, space, _ or -");
  }

  return {
    id: crypto.randomUUID(),
    displayName: name
  };
}
