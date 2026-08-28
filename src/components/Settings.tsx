/** Settings: who you are, the rules, your plan, sign out. */
import { useEffect, useState } from "react";
import type { Me, PlanView } from "../../shared/api";
import { DEFAULT_GUARDRAILS, type Guardrails } from "../../shared/spec";
import { api } from "../lib/api";
import { GuardrailsForm } from "./GuardrailsForm";

export function Settings(props: { me: Me; onUpdated: (m: Me) => void; onSignOut: () => void; say: (s: string) => void }) {
  const p = props.me.profile;
  const [name, setName] = useState(p?.name ?? "");
  const [timezone, setTimezone] = useState(p?.timezone ?? "UTC");
  const [about, setAbout] = useState(p?.about ?? "");
  const [guardrails, setGuardrails] = useState<Guardrails>(p?.guardrails ?? DEFAULT_GUARDRAILS);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<PlanView | null | "none">(null);

  useEffect(() => {
    api
      .plan()
      .then(setPlan)
      .catch(() => setPlan("none"));
  }, []);

  const save = async () => {
    setBusy(true);
    try {
      props.onUpdated(await api.saveProfile({ name: name.trim(), timezone, about, guardrails }));
      props.say("Saved. Reflex will follow the new rules from its next reply.");
    } catch (e) {
      props.say(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings">
      <h2>About you</h2>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Timezone
        <input value={timezone} onChange={(e) => setTimezone(e.target.value)} />
      </label>
      <label>
        What Reflex should know
        <textarea value={about} onChange={(e) => setAbout(e.target.value)} rows={5} />
      </label>
      <h2>Rules</h2>
      <GuardrailsForm value={guardrails} onChange={setGuardrails} />
      <button className="primary" disabled={busy} onClick={() => void save()}>
        {busy ? "Saving…" : "Save"}
      </button>

      <h2>Your plan</h2>
      {plan === null ? (
        <p className="fineprint">Checking…</p>
      ) : plan === "none" || plan.balanceCents === null ? (
        <p className="fineprint">This Reflex does not bill you.</p>
      ) : (
        <div className="panel">
          <p>
            Balance: <b>{dollars(plan.balanceCents)}</b>
            {plan.hourCents !== null && <span className="fineprint"> · about {dollars(plan.hourCents)} for each hour Reflex works</span>}
          </p>
          {plan.balanceCents < 500 && <p className="error small">Running low. Reflex stops when the balance hits zero.</p>}
          {plan.addUrl && (
            <a className="ghost" href={plan.addUrl} target="_blank" rel="noopener">
              Add funds
            </a>
          )}
        </div>
      )}

      <h2>Account</h2>
      <p className="fineprint">Signed in as {props.me.email}</p>
      <button className="ghost" onClick={props.onSignOut}>
        Sign out
      </button>
      <p className="fineprint">Signing out on this device does not stop Reflex. Its jobs and routines keep going.</p>
      <p className="fineprint">
        Reflex runs on <a href="https://github.com/BinaryBourbon/fountain">Fountain</a> · <a href="https://github.com/managoat/reflex">source</a> · {__APP_COMMIT__}
      </p>
    </div>
  );
}

function dollars(cents: number): string {
  return (cents / 100).toLocaleString(undefined, { style: "currency", currency: "USD" });
}
