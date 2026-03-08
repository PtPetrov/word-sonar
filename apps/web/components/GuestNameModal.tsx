"use client";

import { useState } from "react";

type GuestNameModalProps = {
  initialName?: string;
  title?: string;
  description?: string;
  submitLabel?: string;
  cancelLabel?: string;
  autoFocus?: boolean;
  onCancel?: () => void;
  onSave: (displayName: string) => void;
};

export function GuestNameModal({
  initialName = "",
  title = "Choose guest name",
  description = "This name is used for rooms and the daily solo leaderboard.",
  submitLabel = "Continue",
  cancelLabel = "Not now",
  autoFocus = true,
  onCancel,
  onSave
}: GuestNameModalProps) {
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
        <h2 className="big">{title}</h2>
        <p className="muted">{description}</p>
        <div>
          <label htmlFor="guest-name-input">Display name</label>
          <input
            id="guest-name-input"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            maxLength={20}
            autoFocus={autoFocus}
          />
        </div>
        {error ? <p className="error">{error}</p> : null}
        <div className="inline">
          {onCancel ? (
            <button type="button" className="button ghost" onClick={onCancel}>
              {cancelLabel}
            </button>
          ) : null}
          <button type="submit">{submitLabel}</button>
        </div>
      </form>
    </div>
  );
}
