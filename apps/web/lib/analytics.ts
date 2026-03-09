"use client";

import posthog from "posthog-js";
import type { GuestIdentity } from "@/lib/guest";

type AnalyticsProperties = Record<string, string | number | boolean | null | undefined>;

const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim() ?? "";
const POSTHOG_HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim() ?? "";
const DICTIONARY_VERSION = process.env.NEXT_PUBLIC_DICTIONARY_VERSION ?? "unknown";

let initialized = false;

export function isAnalyticsEnabled(): boolean {
  return POSTHOG_KEY.length > 0;
}

export function initAnalytics(): void {
  if (initialized || typeof window === "undefined" || !isAnalyticsEnabled()) {
    return;
  }

  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST || "https://us.i.posthog.com",
    capture_pageview: "history_change",
    disable_session_recording: true,
    persistence: "localStorage+cookie",
    loaded: (client) => {
      client.register({
        app: "word_hunt_web",
        dictionary_version: DICTIONARY_VERSION
      });
    }
  });

  initialized = true;
}

export function identifyAnalyticsUser(identity: GuestIdentity, properties: AnalyticsProperties = {}): void {
  if (!isAnalyticsEnabled()) {
    return;
  }

  initAnalytics();
  posthog.identify(identity.id, {
    display_name: identity.displayName,
    ...properties
  });
}

export function captureAnalyticsEvent(event: string, properties: AnalyticsProperties = {}): void {
  if (!isAnalyticsEnabled()) {
    return;
  }

  initAnalytics();
  posthog.capture(event, properties);
}
