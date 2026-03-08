import { PageShell } from "@/components/PageShell";
import { HomePlayPicker } from "@/components/HomePlayPicker";

const HOME_SCAN_DURATION_S = 8;

const homeSignals = [
  { id: "s1", top: 20, left: 52, size: 5 },
  { id: "s2", top: 31, left: 74, size: 4 },
  { id: "s3", top: 49, left: 19, size: 5 },
  { id: "s4", top: 66, left: 72, size: 4 },
  { id: "s5", top: 76, left: 33, size: 5 },
  { id: "s6", top: 57, left: 84, size: 3 },
] as const;

const homeBlips = [
  { id: "b1", top: 27, left: 67, variant: "home-radar-blip-green" },
  { id: "b2", top: 71, left: 26, variant: "home-radar-blip-bright" },
  { id: "b3", top: 41, left: 81, variant: "home-radar-blip-muted" },
] as const;

function scanDelayForPoint(top: number, left: number): string {
  const x = left - 50;
  const y = top - 50;
  const angle = (Math.atan2(y, x) * 180) / Math.PI;
  const normalized = (angle + 360) % 360;
  const delay = -((normalized / 360) * HOME_SCAN_DURATION_S);
  return `${delay.toFixed(2)}s`;
}

export default function HomePage() {
  return (
    <PageShell showHeader={false}>
      <section className="home-minimal">
        <div className="home-copy">
          <div className="home-mark" aria-label="Word Sonar">
            <span className="logo-radar-dot" />
            <span className="logo-text">WORD SONAR</span>
          </div>
          <h1 className="display home-title">Find the hidden word with semantic radar.</h1>
          <p className="hero-body home-subtitle">
            Play solo or challenge a friend. Each guess shows whether you&apos;re
            getting semantically closer.
          </p>
          <p className="home-rules-preview">Guess a word. Read the radar. Find the exact target.</p>
        </div>

        <div className="home-radar-wrap">
          <div
            className="home-radar"
            aria-hidden="true"
            style={
              {
                "--home-scan-duration": `${HOME_SCAN_DURATION_S}s`,
              } as React.CSSProperties
            }
          >
            <div className="home-radar-ring r1" />
            <div className="home-radar-ring r2" />
            <div className="home-radar-ring r3" />
            <div className="home-radar-sweep" />
            {homeSignals.map((signal) => (
              <span
                key={signal.id}
                className="home-radar-signal"
                style={
                  {
                    "--signal-top": `${signal.top}%`,
                    "--signal-left": `${signal.left}%`,
                    "--signal-delay": scanDelayForPoint(
                      signal.top,
                      signal.left,
                    ),
                    "--signal-size": `${signal.size}px`,
                  } as React.CSSProperties
                }
              />
            ))}
            {homeBlips.map((blip) => (
              <span
                key={blip.id}
                className={`home-radar-blip ${blip.variant}`}
                style={
                  {
                    "--blip-top": `${blip.top}%`,
                    "--blip-left": `${blip.left}%`,
                    "--blip-delay": scanDelayForPoint(blip.top, blip.left),
                  } as React.CSSProperties
                }
              />
            ))}
          </div>
        </div>

        <HomePlayPicker />
      </section>
    </PageShell>
  );
}
