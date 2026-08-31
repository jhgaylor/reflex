/** Connections: how Reflex reaches you, and what it may use. Shared with the setup wizard. */
import { useEffect, useState } from "react";
import type { ConnectionsView } from "../../shared/api";
import { api } from "../lib/api";

export function Connections({ say }: { say: (s: string) => void }) {
  const [view, setView] = useState<ConnectionsView | null>(null);
  useEffect(() => {
    api.connections().then(setView).catch((e: Error) => say(e.message));
    // Connecting a service happens in another tab; catch up when the owner returns.
    const refetch = () => api.connections().then(setView).catch(() => undefined);
    window.addEventListener("focus", refetch);
    return () => window.removeEventListener("focus", refetch);
  }, [say]);
  if (!view) return <p className="fineprint">Loading…</p>;
  return (
    <div className="connections">
      <h2>Texting</h2>
      <TextingPanel view={view} onChange={setView} say={say} />
      <h2>Accounts Reflex may use</h2>
      <ServicesPanel view={view} onChange={setView} say={say} />
      <AccountsPanel view={view} onChange={setView} say={say} />
    </div>
  );
}

export function TextingPanel({ view, onChange, say }: { view: ConnectionsView; onChange: (v: ConnectionsView) => void; say: (s: string) => void }) {
  const [number, setNumber] = useState(view.contact?.yourNumber ?? "");
  const [busy, setBusy] = useState(false);

  if (!view.texting.available) {
    return (
      <div className="panel muted">
        <b>Texting is not available on this account yet.</b>
        <p className="fineprint">{view.texting.reason ?? "You can still do everything from this page."}</p>
      </div>
    );
  }

  if (view.contact?.phone) {
    return (
      <div className="panel">
        <p>
          Text Reflex at <b className="mono">{view.contact.phone}</b> from <b className="mono">{view.contact.yourNumber}</b>. Save it as a contact.
        </p>
        {view.contact.email && (
          <p className="fineprint">
            It also has an email address, <span className="mono">{view.contact.email}</span>, which it uses to send and receive mail on your behalf.
          </p>
        )}
        {view.contact.optedOut && <p className="error small">You replied STOP, so Reflex will not text you. Text START to turn it back on.</p>}
        <button
          className="linkish"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            api
              .disableTexting()
              .then(onChange)
              .catch((e: Error) => say(e.message))
              .finally(() => setBusy(false));
          }}
        >
          turn off texting
        </button>
      </div>
    );
  }

  return (
    <div className="panel">
      <p>Give Reflex your mobile number and it gets a number of its own. Texts from your phone reach it; it texts you back when something matters.</p>
      <label>
        Your mobile number
        <input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="+1 555 123 4567" inputMode="tel" />
      </label>
      <button
        className="primary"
        disabled={busy || number.replace(/\D/g, "").length < 10}
        onClick={() => {
          setBusy(true);
          api
            .enableTexting(number.trim())
            .then((v) => {
              onChange(v);
              say("Reflex has a phone number now.");
            })
            .catch((e: Error) => say(e.message))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "Setting up…" : "Turn on texting"}
      </button>
      <p className="fineprint">Only texts from this number are treated as instructions. Anyone else who texts it is ignored.</p>
    </div>
  );
}

/** Sign in once — Gmail today — and Reflex gets the tools without ever holding the password. */
export function ServicesPanel({ view, onChange, say }: { view: ConnectionsView; onChange: (v: ConnectionsView) => void; say: (s: string) => void }) {
  const s = view.services;
  const [busy, setBusy] = useState<string | null>(null);
  if (!s.available && s.connected.length === 0) {
    if (s.offered.length === 0 && !s.reason) return null;
    return (
      <div className="panel muted">
        <p className="fineprint">{s.reason ?? "Signing in to services is not available on this account yet."}</p>
      </div>
    );
  }
  if (s.offered.length === 0 && s.connected.length === 0) return null;
  return (
    <div className="panel">
      {s.connected.length > 0 && (
        <ul className="accounts">
          {s.connected.map((c) => {
            const drop = (done: string) => {
              setBusy(c.id);
              api
                .disconnectService(c.id)
                .then((v) => {
                  onChange(v);
                  say(done);
                })
                .catch((e: Error) => say(e.message))
                .finally(() => setBusy(null));
            };
            return (
              <li key={c.id}>
                <b>{c.label}</b> <span className="fineprint mono">{c.email}</span>
                {c.revoked ? (
                  <>
                    <span className="error small">signed out</span>
                    {c.connectUrl && (
                      <a className="linkish" href={c.connectUrl} target="_blank" rel="noreferrer">
                        connect again
                      </a>
                    )}
                    <button className="linkish" disabled={busy === c.id} onClick={() => drop(`${c.label} is gone.`)}>
                      remove
                    </button>
                  </>
                ) : (
                  <button className="linkish" disabled={busy === c.id} onClick={() => drop(`${c.label} is disconnected.`)}>
                    disconnect
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {s.offered.length > 0 && (
        <div className="chips">
          {s.offered.map((p) => (
            <a key={p.provider} className="ghost" href={p.connectUrl} target="_blank" rel="noreferrer">
              Connect {p.label}
            </a>
          ))}
        </div>
      )}
      <p className="fineprint">You sign in in a new tab; Reflex gets the tools, never your password. This page catches up when you come back.</p>
    </div>
  );
}

const SUGGESTED: Array<{ key: string; label: string; hint: string }> = [
  { key: "EMAIL_ADDRESS", label: "Email address", hint: "The mailbox Reflex should read and send from" },
  { key: "EMAIL_APP_PASSWORD", label: "Email app password", hint: "An app-specific password, not your real one" },
  { key: "CALDAV_URL", label: "Calendar link", hint: "A CalDAV or ICS URL for your calendar" },
  { key: "CALDAV_PASSWORD", label: "Calendar password", hint: "" },
];

export function AccountsPanel({ view, onChange, say }: { view: ConnectionsView; onChange: (v: ConnectionsView) => void; say: (s: string) => void }) {
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const have = new Set(view.accounts.map((a) => a.key));

  const add = () => {
    const k = (key || label).trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (!k || !value) return;
    setBusy(true);
    api
      .addAccount({ key: k, label: label.trim() || k, value })
      .then((v) => {
        onChange(v);
        setLabel("");
        setKey("");
        setValue("");
      })
      .catch((e: Error) => say(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="panel">
      {view.accounts.length > 0 && (
        <ul className="accounts">
          {view.accounts.map((a) => (
            <li key={a.key}>
              <b>{a.label}</b> <span className="fineprint mono">{a.key}</span>
              <button
                className="linkish"
                onClick={() =>
                  api
                    .removeAccount(a.key)
                    .then(onChange)
                    .catch((e: Error) => say(e.message))
                }
              >
                remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="chips">
        {SUGGESTED.filter((s) => !have.has(s.key)).map((s) => (
          <button
            key={s.key}
            className="chip"
            onClick={() => {
              setLabel(s.label);
              setKey(s.key);
            }}
            title={s.hint}
          >
            + {s.label}
          </button>
        ))}
      </div>
      <div className="account-form">
        <label>
          What is it
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Email app password" />
        </label>
        <label>
          The secret
          <input value={value} onChange={(e) => setValue(e.target.value)} type="password" placeholder="••••••••" autoComplete="off" />
        </label>
        <button className="ghost" disabled={busy || !value || !(label || key)} onClick={add}>
          {busy ? "Saving…" : "Add"}
        </button>
      </div>
      <p className="fineprint">
        Stored once, never shown again, not even to Reflex's chat. Reflex uses it on its computer when it needs to log in.
        {key && (
          <>
            {" "}
            Saved as <span className="mono">{key}</span>.
          </>
        )}
      </p>
    </div>
  );
}
