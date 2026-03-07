import { prisma } from "@word-hunt/db";
import { PageShell } from "@/components/PageShell";
import { getSofiaDateString } from "@/lib/time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function LeaderboardPage() {
  const date = getSofiaDateString();
  const dateValue = new Date(`${date}T00:00:00.000Z`);

  const entries = await prisma.dailySoloEntry.findMany({
    where: { date: dateValue },
    include: { user: true },
    orderBy: [{ turnsToSolve: "asc" }, { timeMs: "asc" }],
    take: 100
  });

  return (
    <PageShell>
      <section className="panel page-headline">
        <p className="eyebrow">LEADERBOARD</p>
        <h1 className="display-sm">Daily Hunters</h1>
        <p className="muted">Date: {date} (Europe/Sofia)</p>
      </section>

      <section className="podium-grid">
        {entries.slice(0, 3).map((entry, index) => (
          <article key={entry.userId} className={`podium-card panel p${index + 1}`}>
            <p className="stat-label">#{index + 1}</p>
            <h3>{entry.user.displayName}</h3>
            <p>{entry.turnsToSolve} guesses</p>
            <p>{(entry.timeMs / 1000).toFixed(1)}s</p>
          </article>
        ))}
      </section>

      <section className="panel">
        <table className="table leaderboard-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Player</th>
              <th>Guesses</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, index) => (
              <tr key={entry.userId}>
                <td>{index + 1}</td>
                <td>{entry.user.displayName}</td>
                <td>{entry.turnsToSolve}</td>
                <td>{(entry.timeMs / 1000).toFixed(1)}s</td>
              </tr>
            ))}
            {entries.length === 0 ? (
              <tr>
                <td colSpan={4}>No entries yet.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </PageShell>
  );
}
