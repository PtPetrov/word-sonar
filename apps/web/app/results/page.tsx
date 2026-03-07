import Link from "next/link";
import { PageShell } from "@/components/PageShell";

type ResultsPageProps = {
  searchParams: Promise<{
    turns?: string;
    timeMs?: string;
    won?: string;
    mode?: string;
  }>;
};

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export default async function ResultsPage({ searchParams }: ResultsPageProps) {
  const query = await searchParams;
  const turns = parseNumber(query.turns, 0);
  const timeMs = parseNumber(query.timeMs, 0);
  const won = query.won !== "0";
  const mode = query.mode ?? "daily";

  return (
    <PageShell>
      <section className="panel results-shell">
        <p className="eyebrow">RESULTS</p>
        <h1 className="display-sm">{won ? "Target Captured" : "Signal Lost"}</h1>
        <p className="muted">Mode: {mode}</p>

        <div className="stats-grid">
          <article className="stat-card">
            <p className="stat-label">Guesses</p>
            <p className="stat-value">{turns}</p>
          </article>
          <article className="stat-card">
            <p className="stat-label">Time</p>
            <p className="stat-value">{Math.round(timeMs / 1000)}s</p>
          </article>
          <article className="stat-card">
            <p className="stat-label">Result</p>
            <p className="stat-value">{won ? "Win" : "Retry"}</p>
          </article>
        </div>

        <div className="inline">
          <Link className="button success" href="/solo">
            Play Again
          </Link>
          <Link className="button secondary" href="/leaderboard">
            Leaderboard
          </Link>
        </div>
      </section>
    </PageShell>
  );
}
