import Link from "next/link";
import { PageShell } from "@/components/PageShell";

const modes = [
  {
    title: "Daily Challenge",
    description: "Fresh target each day. Protect your streak.",
    cta: "Play Daily",
    href: "/solo",
    tone: "primary"
  },
  {
    title: "Endless Hunt",
    description: "Back-to-back random targets until you quit.",
    cta: "Start Endless",
    href: "/solo",
    tone: "success"
  },
  {
    title: "Timed Sprint",
    description: "Beat the clock and hunt with pressure.",
    cta: "Start Timed",
    href: "/solo",
    tone: "excitement"
  },
  {
    title: "Multiplayer Rooms",
    description: "Create private rooms for co-op and team battles.",
    cta: "Open Rooms",
    href: "/room",
    tone: "secondary"
  }
] as const;

export default function ModesPage() {
  return (
    <PageShell>
      <section className="panel page-headline">
        <p className="eyebrow">MODE SELECT</p>
        <h1 className="display-sm">Pick Your Hunt</h1>
        <p className="muted">Each mode keeps the same radar mechanic with different pressure loops.</p>
      </section>

      <section className="mode-grid">
        {modes.map((mode) => (
          <article key={mode.title} className="mode-card panel">
            <h2>{mode.title}</h2>
            <p>{mode.description}</p>
            <Link className={`button ${mode.tone}`} href={mode.href}>
              {mode.cta}
            </Link>
          </article>
        ))}
      </section>
    </PageShell>
  );
}
