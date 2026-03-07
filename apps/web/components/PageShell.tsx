"use client";

import Link from "next/link";

export function PageShell({
  children,
  showHeader = true
}: {
  children: React.ReactNode;
  showHeader?: boolean;
}) {
  return (
    <main className="page">
      {showHeader ? (
        <header className="topbar">
          <Link href="/" className="logo-lockup" aria-label="Word Sonar home">
            <span className="logo-radar-dot" />
            <span className="logo-text">WORD SONAR</span>
          </Link>
        </header>
      ) : null}
      {children}
    </main>
  );
}
