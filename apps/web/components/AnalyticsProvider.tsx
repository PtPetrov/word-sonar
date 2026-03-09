"use client";

import { PostHogProvider } from "@posthog/react";
import posthog from "posthog-js";
import { initAnalytics, isAnalyticsEnabled } from "@/lib/analytics";

export function AnalyticsProvider({ children }: { children: React.ReactNode }) {
  initAnalytics();

  if (!isAnalyticsEnabled()) {
    return <>{children}</>;
  }

  return <PostHogProvider client={posthog}>{children}</PostHogProvider>;
}
