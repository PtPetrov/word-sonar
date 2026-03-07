import { PageShell } from "@/components/PageShell";

export default function ProfilePage() {
  return (
    <PageShell>
      <section className="panel page-headline">
        <p className="eyebrow">PROFILE</p>
        <h1 className="display-sm">Your Hunt Stats</h1>
      </section>

      <section className="stats-grid">
        <article className="stat-card">
          <p className="stat-label">Current Streak</p>
          <p className="stat-value">7</p>
        </article>
        <article className="stat-card">
          <p className="stat-label">Best Streak</p>
          <p className="stat-value">19</p>
        </article>
        <article className="stat-card">
          <p className="stat-label">Avg Guesses</p>
          <p className="stat-value">14.2</p>
        </article>
        <article className="stat-card">
          <p className="stat-label">Win Rate</p>
          <p className="stat-value">82%</p>
        </article>
      </section>

      <section className="panel">
        <h2 className="heading">Recent Form</h2>
        <div className="profile-heatmap">
          {Array.from({ length: 28 }, (_, index) => (
            <span
              key={index}
              className={`heatmap-cell${index % 5 === 0 ? " hot" : index % 3 === 0 ? " warm" : ""}`}
              aria-hidden="true"
            />
          ))}
        </div>
      </section>
    </PageShell>
  );
}
