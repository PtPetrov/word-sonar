"use client";

import { DISPLAY_NAME_REGEX } from "@word-hunt/shared";

const GUEST_KEY = "word_hunt_guest";

export type GuestIdentity = {
  id: string;
  displayName: string;
};

export function readGuestIdentity(): GuestIdentity | null {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.localStorage.getItem(GUEST_KEY);
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
