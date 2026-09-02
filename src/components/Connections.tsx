/** Connections: how Reflex reaches you, and what it may use. Shared with the setup wizard. */
import { useEffect, useState } from "react";
import type { ConnectionsView, MessagePairingView } from "../../shared/api";
import { RELAY_CHANNELS, RELAY_KINDS, type RelayKind } from "../../shared/spec";
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
      <RelaysPanel view={view} onChange={setView} say={say} />
      <ServicesPanel view={view} onChange={setView} say={say} />
      <AccountsPanel view={view} onChange={setView} say={say} />
    </div>
  );
}

const RELAY_COPY: Record<RelayKind, { hostNoun: string; pitch: string; where: string; fineprint: string }> = {
  imessage: {
    hostNoun: "Mac",
    pitch: "Pair an always-on Mac to let Reflex search your Messages and, with your approval, send plain-text replies as you.",
    where: "On the Mac signed in to Messages, open this Reflex checkout and run:",
    fineprint: "The relay reads Messages locally. Reflex never receives your Apple password.",
  },
  signal: {
    hostNoun: "relay",
    pitch: "Pair a computer running signal-cli, linked to your phone as a Signal device, to let Reflex read Signal chats from that point on and, with your approval, reply as you.",
    where: "On the computer you linked with `bun run signal:relay -- --link`, open this Reflex checkout and run:",
    fineprint: "Signal keys stay on that computer; Reflex only sees what the relay answers.",
  },
};

/** One card per chat app the owner can pair a relay for. Shared with the setup wizard. */
export function RelaysPanel({ view, onChange, say }: { view: ConnectionsView; onChange: (v: ConnectionsView) => void; say: (s: string) => void }) {
  return (
    <>
      {RELAY_KINDS.map((kind) => (
        <RelayPanel key={kind} kind={kind} view={view} onChange={onChange} say={say} />
      ))}
    </>
  );
}

function RelayPanel({ kind, view, onChange, say }: { kind: RelayKind; view: ConnectionsView; onChange: (v: ConnectionsView) => void; say: (s: string) => void }) {
  const [pairing, setPairing] = useState<MessagePairingView | null>(null);
  const [busy, setBusy] = useState(false);
  const devices = view.relays.filter((d) => d.kind === kind);
  const copy = RELAY_COPY[kind];
  const channel = RELAY_CHANNELS[kind];

  useEffect(() => {
    const every = pairing ? 3000 : devices.length > 0 ? 30_000 : 0;
    if (!every) return;
    const timer = setInterval(() => api.connections().then(onChange).catch(() => undefined), every);
    return () => clearInterval(timer);
  }, [onChange, pairing, devices.length]);

  useEffect(() => {
    if (devices.length > 0) setPairing(null);
  }, [devices.length]);

  const command = pairing ? `bun run ${channel.script} -- --server ${window.location.origin} --code ${pairing.code}` : "";
  return (
    <div className="panel">
      <h3>{channel.title}</h3>
      {devices.length > 0 ? (
        <ul className="accounts">
          {devices.map((d) => (
            <li key={d.id}>
              <b>{d.name}</b>
              <span className={d.connected ? "small" : "fineprint small"}>{d.connected ? "connected" : d.lastSeenAt ? `last seen ${new Date(d.lastSeenAt).toLocaleString()}` : "waiting to connect"}</span>
              <button
                className="linkish"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  api.disconnectRelay(d.id).then(onChange).catch((e: Error) => say(e.message)).finally(() => setBusy(false));
                }}
              >
                disconnect
              </button>
            </li>
          ))}
        </ul>
      ) : pairing ? (
        <>
          <p>{copy.where}</p>
          <pre className="pair-command"><code>{command}</code></pre>
          <button className="ghost" onClick={() => navigator.clipboard.writeText(command).then(() => say("Pairing command copied.")).catch(() => say("Could not copy it; select the command instead."))}>
            Copy command
          </button>
          <p className="fineprint">The code expires at {new Date(pairing.expiresAt).toLocaleTimeString()}. The first run saves the pairing; later, run <span className="mono">bun run {channel.script}</span>.</p>
        </>
      ) : (
        <>
          <p>{copy.pitch}</p>
          <button
            className="ghost"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              api.pairRelay(kind).then(setPairing).catch((e: Error) => say(e.message)).finally(() => setBusy(false));
            }}
          >
            {busy ? "Creating code…" : `Pair a ${copy.hostNoun}`}
          </button>
        </>
      )}
      <p className="fineprint">{copy.fineprint}</p>
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

/** Sign in once and Reflex gets the tools without ever holding the password. Services Fountain cannot connect yet show as "soon". */
export function ServicesPanel({ view, onChange, say }: { view: ConnectionsView; onChange: (v: ConnectionsView) => void; say: (s: string) => void }) {
  const s = view.services;
  const [busy, setBusy] = useState<string | null>(null);
  if (s.groups.length === 0) return null;
  const anythingLive = s.groups.some((g) => g.services.some((sv) => sv.state !== "soon"));

  const drop = (sv: { connectionId: string | null; label: string }, done: string) => {
    if (!sv.connectionId) return;
    setBusy(sv.connectionId);
    api
      .disconnectService(sv.connectionId)
      .then((v) => {
        onChange(v);
        say(done);
      })
      .catch((e: Error) => say(e.message))
      .finally(() => setBusy(null));
  };

  return (
    <div className="panel">
      {s.groups.map((g) => (
        <div className="svc-group" key={g.kind}>
          <h3>{g.title}</h3>
          <ul className="accounts">
            {g.services.map((sv) => (
              <li key={sv.id}>
                <b>{sv.label}</b>
                {sv.email && <span className="fineprint mono">{sv.email}</span>}
                {sv.state === "connected" && (
                  <button className="linkish" disabled={busy === sv.connectionId} onClick={() => drop(sv, `${sv.label} is disconnected.`)}>
                    disconnect
                  </button>
                )}
                {sv.state === "revoked" && (
                  <>
                    <span className="error small">signed out</span>
                    {sv.connectUrl && (
                      <a className="linkish" href={sv.connectUrl} target="_blank" rel="noreferrer">
                        connect again
                      </a>
                    )}
                    <button className="linkish" disabled={busy === sv.connectionId} onClick={() => drop(sv, `${sv.label} is gone.`)}>
                      remove
                    </button>
                  </>
                )}
                {sv.state === "offered" && sv.connectUrl && (
                  <a className="ghost" href={sv.connectUrl} target="_blank" rel="noreferrer">
                    Connect
                  </a>
                )}
                {sv.state === "soon" && (
                  <span className="soon" title="Reflex cannot connect this one yet.">
                    soon
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {s.reason && <p className="fineprint">{s.reason}</p>}
      {anythingLive && <p className="fineprint">You sign in in a new tab; Reflex gets the tools, never your password. This page catches up when you come back.</p>}
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
