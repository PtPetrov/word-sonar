import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Word Sonar",
  description: "Turn-based contexto-style multiplayer word game"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-motion="full">
      <body>{children}</body>
    </html>
  );
}
