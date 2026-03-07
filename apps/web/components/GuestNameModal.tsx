"use client";

import { useState } from "react";

type GuestNameModalProps = {
  initialName?: string;
  onSave: (displayName: string) => void;
};

export function GuestNameModal({ initialName = "", onSave }: GuestNameModalProps) {
  const [displayName, setDisplayName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = displayName.trim();

    if (!/^[a-zA-Z0-9 _-]{2,20}$/u.test(trimmed)) {
      setError("Use 2-20 chars with letters, numbers, space, _ or -");
      return;
    }

    setError(null);
    onSave(trimmed);
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Guest name">
      <form className="modal stack" onSubmit={submit}>
        <h2 className="big">Choose guest name</h2>
        <p className="muted">This name is used for rooms and the daily solo leaderboard.</p>
        <div>
          <label htmlFor="guest-name-input">Display name</label>
          <input
            id="guest-name-input"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            maxLength={20}
            autoFocus
          />
        </div>
        {error ? <p className="error">{error}</p> : null}
        <div className="inline">
          <button type="submit">Continue</button>
        </div>
      </form>
    </div>
  );
}
