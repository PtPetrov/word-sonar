import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Word Sonar",
  description: "Turn-based contexto-style multiplayer word game"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-motion="full" data-intensity="standard" suppressHydrationWarning>
      <body>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var root = document.documentElement;
                  var raw = window.localStorage.getItem("word_hunt_settings");
                  if (!raw) return;
                  var parsed = JSON.parse(raw);
                  if (parsed && typeof parsed.motion === "string") {
                    root.dataset.motion = parsed.motion;
                  }
                  if (parsed && typeof parsed.intensity === "string") {
                    root.dataset.intensity = parsed.intensity;
                  }
                } catch (error) {
                  console.warn("Failed to load Word Sonar settings", error);
                }
              })();
            `
          }}
        />
        {children}
      </body>
    </html>
  );
}
