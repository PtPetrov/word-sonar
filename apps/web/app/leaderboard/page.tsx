import Link from "next/link";
import { PageShell } from "@/components/PageShell";

export default function LeaderboardPage() {
  return (
    <PageShell>
      <section className="panel results-shell">
        <p className="eyebrow">LEADERBOARD</p>
        <h1 className="display-sm">Unavailable for now</h1>
        <p className="muted">Solo is currently random per run, so the leaderboard is disabled.</p>
        <div className="inline">
          <Link className="button success" href="/solo">
            Play Solo
          </Link>
        </div>
      </section>
    </PageShell>
  );
}
