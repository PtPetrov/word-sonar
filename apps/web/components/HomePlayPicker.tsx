"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function HomePlayPicker() {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="home-actions">
        <button
          type="button"
          className="button primary big home-primary-action"
          onClick={() => setOpen(true)}
        >
          Play
        </button>
      </div>

      {open ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Choose how to play"
          onClick={() => setOpen(false)}
        >
          <div className="modal home-play-modal stack" onClick={(event) => event.stopPropagation()}>
            <h2 className="big">Choose your mode</h2>
            <div className="stack">
              <button
                type="button"
                className="button primary big home-primary-action"
                onClick={() => router.push("/solo")}
              >
                Play solo
              </button>
              <button
                type="button"
                className="button primary big home-primary-action"
                onClick={() => router.push("/lobby")}
              >
                Play with friends
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
