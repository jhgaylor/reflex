/**
 * First run, as a guided walk rather than a settings page: who you are,
 * how Reflex should reach you, what accounts it may use, and the rules.
 * Each step saves as it goes, so closing the tab loses nothing.
 */
import { useEffect, useState } from "react";
import type { ConnectionsView, Me } from "../../shared/api";
import { DEFAULT_GUARDRAILS, STARTER_JOBS, type Guardrails } from "../../shared/spec";
import { api } from "../lib/api";
import { GuardrailsForm } from "./GuardrailsForm";
import { AccountsPanel, ServicesPanel, TextingPanel } from "./Connections";

type Step = 0 | 1 | 2 | 3;

export function Setup(props: { me: Me; onDone: (m: Me) => void; onSignOut: () => void; say: (s: string) => void }) {
  const { me } = props;
  const [step, setStep] = useState<Step>(me.setupStep === "reach" ? 1 : me.setupStep === "accounts" ? 2 : 0);
  const [name, setName] = useState(me.profile?.name ?? "");
  const [timezone, setTimezone] = useState(me.profile?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [about, setAbout] = useState(me.profile?.about ?? "");
  const [guardrails, setGuardrails] = useState<Guardrails>(me.profile?.guardrails ?? DEFAULT_GUARDRAILS);
  const [busy, setBusy] = useState(false);
  const [connections, setConnections] = useState<ConnectionsView | null>(null);
  const [firstAsk, setFirstAsk] = useState("");

  useEffect(() => {
    if (step < 1) return;
    api.connections().then(setConnections).catch(() => undefined);
    // Connecting a service happens in another tab; catch up when the owner returns.
    const refetch = () => api.connections().then(setConnections).catch(() => undefined);
    window.addEventListener("focus", refetch);
    return () => window.removeEventListener("focus", refetch);
  }, [step]);

  const saveProfile = async () => {
    setBusy(true);
    try {
      await api.saveProfile({ name: name.trim(), timezone, about, guardrails });
      setStep(1);
    } catch (err) {
      props.say(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    setBusy(true);
    try {
      await api.saveProfile({ name: name.trim(), timezone, about, guardrails });
      const m = await api.finishSetup();
      if (firstAsk.trim()) await api.send(firstAsk.trim()).catch((e: Error) => props.say(e.message));
      props.onDone(m);
    } catch (err) {
      props.say(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="welcome">
      <div className="welcome-card wide">
        <div className="brand">
          <span className="mark" />
          Reflex
        </div>
        <ol className="steps">
          {["About you", "Reach you", "Accounts", "First job"].map((s, i) => (
            <li key={s} className={i === step ? "active" : i < step ? "done" : ""}>
              {s}
            </li>
          ))}
        </ol>

        {step === 0 && (
          <>
            <h2>Tell Reflex who it works for.</h2>
            <label>
              What should it call you?
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jake" autoFocus />
            </label>
            <label>
              Your timezone
              <input value={timezone} onChange={(e) => setTimezone(e.target.value)} />
            </label>
            <label>
              Anything it should know
              <textarea
                value={about}
                onChange={(e) => setAbout(e.target.value)}
                rows={5}
                placeholder="Where you live, who is in your household, your home airport, how you like things done. It will pick up the rest as you go."
              />
            </label>
            <h3>Rules</h3>
            <GuardrailsForm value={guardrails} onChange={setGuardrails} />
            <div className="row">
              <button className="primary" onClick={() => void saveProfile()} disabled={busy}>
                {busy ? "Saving…" : "Continue"}
              </button>
              <button className="linkish" onClick={props.onSignOut}>
                sign out
              </button>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <h2>How should Reflex reach you?</h2>
            <p className="lede">Reflex can have its own phone number, so you can text it from your phone and it can text you back.</p>
            {connections ? <TextingPanel view={connections} onChange={setConnections} say={props.say} /> : <p className="fineprint">Checking…</p>}
            <div className="row">
              <button className="primary" onClick={() => setStep(2)}>
                Continue
              </button>
              <button className="linkish" onClick={() => setStep(0)}>
                back
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h2>What may it use?</h2>
            <p className="lede">
              Sign in to the services Reflex should use, or give it the accounts it will need: an email app password, a calendar
              link, a loyalty login. Anything you add is stored where Reflex can use it but nobody, including Reflex's chat, can
              read it back.
            </p>
            {connections ? (
              <>
                <ServicesPanel view={connections} onChange={setConnections} say={props.say} />
                <AccountsPanel view={connections} onChange={setConnections} say={props.say} />
              </>
            ) : (
              <p className="fineprint">Checking…</p>
            )}
            <div className="row">
              <button className="primary" onClick={() => setStep(3)}>
                Continue
              </button>
              <button className="linkish" onClick={() => setStep(1)}>
                back
              </button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h2>Give it something to do.</h2>
            <p className="lede">Pick one, or write your own. You can always add more from Home.</p>
            <div className="starters">
              {STARTER_JOBS.map((s) => (
                <button key={s.title} className={firstAsk === s.prompt ? "starter active" : "starter"} onClick={() => setFirstAsk(s.prompt)}>
                  {s.title}
                </button>
              ))}
            </div>
            <label>
              Or in your own words
              <textarea value={firstAsk} onChange={(e) => setFirstAsk(e.target.value)} rows={4} placeholder="Find me a good dentist near home and get me an appointment next week." />
            </label>
            <div className="row">
              <button className="primary" onClick={() => void finish()} disabled={busy}>
                {busy ? "Starting Reflex…" : firstAsk.trim() ? "Start and send" : "Start without a job"}
              </button>
              <button className="linkish" onClick={() => setStep(2)}>
                back
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
