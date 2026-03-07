import Link from "next/link";
import { PageShell } from "@/components/PageShell";

const steps = [
  {
    title: "Guess",
    body: "Enter one English word. Every guess becomes a radar blip."
  },
  {
    title: "Read The Signal",
    body: "The radar and heat states show if you are getting closer or farther."
  },
  {
    title: "Hunt Inward",
    body: "Refine with synonyms and related words. Inward movement means semantic progress."
  }
] as const;

export default function HowItWorksPage() {
  return (
    <PageShell>
      <section className="panel page-headline">
        <p className="eyebrow">HOW IT WORKS</p>
        <h1 className="display-sm">Master The Proximity Radar</h1>
      </section>

      <section className="how-grid">
        {steps.map((step, index) => (
          <article key={step.title} className="panel how-card">
            <span className="step-index">0{index + 1}</span>
            <h2>{step.title}</h2>
            <p>{step.body}</p>
          </article>
        ))}
      </section>

      <section className="panel tips-card">
        <h3>Signal Labels</h3>
        <div className="chip-row">
          <span className="chip chip-cold">Cold</span>
          <span className="chip chip-warm">Warm</span>
          <span className="chip chip-hot">Hot</span>
          <span className="chip chip-very-close">Very Close</span>
        </div>
        <p className="muted">Don’t rely on color only. Check labels and direction arrows every turn.</p>
        <Link href="/solo" className="button primary">
          Start A Hunt
        </Link>
      </section>
    </PageShell>
  );
}
