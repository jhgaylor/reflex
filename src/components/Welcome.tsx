/** The front door: one button. The Fountain URL is behind "advanced" for the people who run their own. */
import { useState } from "react";
import { beginLogin, DEFAULT_FOUNTAIN } from "../lib/oauth";

export function Welcome({ error }: { error: string | null }) {
  const [advanced, setAdvanced] = useState(false);
  const [baseUrl, setBaseUrl] = useState(DEFAULT_FOUNTAIN);
  const [busy, setBusy] = useState(false);

  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="brand big">
          <span className="mark" />
          Reflex
        </div>
        <h1>An assistant that actually does things.</h1>
        <p className="lede">
          Text it like a person. It has its own computer, your accounts, and a memory. It books, cancels, negotiates, watches,
          and reports back, while you do something else.
        </p>
        {error && <p className="error">{error}</p>}
        <button
          className="primary xl"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void beginLogin(baseUrl).catch(() => setBusy(false));
          }}
        >
          {busy ? "Taking you to sign in…" : "Sign in"}
        </button>
        <p className="fineprint">
          Sign-in goes through Fountain, which runs the assistant.{" "}
          <button className="linkish" onClick={() => setAdvanced((a) => !a)}>
            {advanced ? "hide" : "advanced"}
          </button>
        </p>
        {advanced && (
          <label>
            Fountain URL
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </label>
        )}
        <ul className="pitch">
          <li>
            <b>Ask before it spends.</b> Money, sent messages and cancellations wait for your OK, unless you say otherwise.
          </li>
          <li>
            <b>Works while you are away.</b> Routines run on a schedule and text you when something matters.
          </li>
          <li>
            <b>Yours to see.</b> Every job, everything it remembers, every account it can use, on one page.
          </li>
        </ul>
      </div>
    </div>
  );
}
