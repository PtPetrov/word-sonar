"use client";

import { useEffect, useState } from "react";
import { PageShell } from "@/components/PageShell";

type MotionLevel = "full" | "reduced" | "off";
type IntensityLevel = "soft" | "standard" | "neon";

export default function SettingsPage() {
  const [soundOn, setSoundOn] = useState(true);
  const [motion, setMotion] = useState<MotionLevel>("full");
  const [intensity, setIntensity] = useState<IntensityLevel>("standard");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const raw = window.localStorage.getItem("word_hunt_settings");
    if (!raw) {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as {
        soundOn?: boolean;
        motion?: MotionLevel;
        intensity?: IntensityLevel;
      };
      if (typeof parsed.soundOn === "boolean") {
        setSoundOn(parsed.soundOn);
      }
      if (parsed.motion) {
        setMotion(parsed.motion);
      }
      if (parsed.intensity) {
        setIntensity(parsed.intensity);
      }
    } catch {
      // ignore malformed local settings
    }
  }, []);

  useEffect(() => {
    document.documentElement.dataset.motion = motion;
  }, [motion]);

  useEffect(() => {
    document.documentElement.dataset.intensity = intensity;
  }, [intensity]);

  const onSave = () => {
    window.localStorage.setItem(
      "word_hunt_settings",
      JSON.stringify({
        soundOn,
        motion,
        intensity
      })
    );
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1400);
  };

  return (
    <PageShell>
      <section className="panel page-headline">
        <p className="eyebrow">SETTINGS</p>
        <h1 className="display-sm">Tune Your Radar</h1>
      </section>

      <section className="panel settings-grid">
        <label className="setting-row">
          <span>Sound</span>
          <input type="checkbox" checked={soundOn} onChange={(event) => setSoundOn(event.target.checked)} />
        </label>

        <div className="setting-row setting-stack">
          <span>Motion Level</span>
          <div className="chip-row">
            {(["full", "reduced", "off"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={motion === value ? "chip chip-selected" : "chip"}
                onClick={() => setMotion(value)}
              >
                {value}
              </button>
            ))}
          </div>
        </div>

        <div className="setting-row setting-stack">
          <span>Theme Intensity</span>
          <div className="chip-row">
            {(["soft", "standard", "neon"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={intensity === value ? "chip chip-selected" : "chip"}
                onClick={() => setIntensity(value)}
              >
                {value}
              </button>
            ))}
          </div>
        </div>

        <div className="setting-row setting-stack">
          <span>Language</span>
          <select defaultValue="en">
            <option value="en">English</option>
          </select>
        </div>

        <button type="button" className="button primary" onClick={onSave}>
          Save Settings
        </button>

        {saved ? <p className="success-copy">Saved.</p> : null}
      </section>
    </PageShell>
  );
}
