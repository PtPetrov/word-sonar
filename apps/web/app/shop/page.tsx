import { PageShell } from "@/components/PageShell";

const items = [
  { name: "Blue Sweep Skin", cost: 150, description: "Sharper radar beam contrast." },
  { name: "Neon Hunt Trail", cost: 220, description: "Glowing guess trail on radar blips." },
  { name: "Pulse Pack", cost: 280, description: "Alternative victory pulse animation." }
] as const;

export default function ShopPage() {
  return (
    <PageShell>
      <section className="panel page-headline">
        <p className="eyebrow">SHOP</p>
        <h1 className="display-sm">Customize Your Hunt</h1>
      </section>

      <section className="mode-grid">
        {items.map((item) => (
          <article key={item.name} className="mode-card panel">
            <h2>{item.name}</h2>
            <p>{item.description}</p>
            <p className="stat-label">{item.cost} coins</p>
            <button type="button" className="button secondary">
              Equip
            </button>
          </article>
        ))}
      </section>
    </PageShell>
  );
}
