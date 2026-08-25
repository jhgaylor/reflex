/** Routines: things Reflex does on a schedule without being asked. Templates first, a clock behind them. */
import { useEffect, useState } from "react";
import type { RoutineView } from "../../shared/api";
import { ROUTINE_TEMPLATES } from "../../shared/spec";
import { api } from "../lib/api";
import { cronError, describeCron, relativeTime } from "../lib/cron";

export function Routines({ say }: { say: (s: string) => void }) {
  const [list, setList] = useState<RoutineView[] | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [custom, setCustom] = useState(false);

  const load = () => api.routines().then(setList).catch((e: Error) => say(e.message));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const add = async (title: string, cron: string, prompt: string) => {
    setAdding(title);
    try {
      await api.addRoutine({ title, cron, prompt });
      await load();
      say(`Added: ${title}, ${describeCron(cron).toLowerCase()}.`);
    } catch (e) {
      say(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(null);
    }
  };

  return (
    <div className="routines">
      <h2>Routines</h2>
      <p className="lede">Reflex runs these on its own and only tells you what is worth knowing.</p>

      {list === null ? (
        <p className="fineprint">Loading…</p>
      ) : list.length === 0 ? (
        <p className="fineprint">No routines yet.</p>
      ) : (
        <ul className="cards">
          {list.map((r) => (
            <RoutineCard key={r.id} r={r} onChange={load} say={say} />
          ))}
        </ul>
      )}

      <h3>Add one</h3>
      <div className="templates">
        {ROUTINE_TEMPLATES.map((t) => (
          <button key={t.id} className="template" disabled={adding !== null} onClick={() => void add(t.title, t.cron, t.prompt)}>
            <b>{t.title}</b>
            <span>{t.description}</span>
            <small>{describeCron(t.cron)}</small>
          </button>
        ))}
      </div>
      {custom ? (
        <CustomRoutine onAdd={add} busy={adding !== null} />
      ) : (
        <button className="linkish" onClick={() => setCustom(true)}>
          write your own
        </button>
      )}
    </div>
  );
}

function RoutineCard({ r, onChange, say }: { r: RoutineView; onChange: () => void; say: (s: string) => void }) {
  const [busy, setBusy] = useState(false);
  const act = async (f: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await f();
      onChange();
      if (done) say(done);
    } catch (e) {
      say(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className={`card${r.enabled ? "" : " off"}`}>
      <div className="card-main">
        <b>{r.title}</b>
        <span className="fineprint">
          {describeCron(r.cron)} · next {relativeTime(r.nextAt)} · last {relativeTime(r.lastAt)}
        </span>
        {r.lastError && <span className="error small">Last run had a problem: {r.lastError}</span>}
        <details>
          <summary className="fineprint">what it asks</summary>
          <p className="fineprint">{r.prompt}</p>
        </details>
      </div>
      <div className="card-side">
        <button className="ghost" disabled={busy} onClick={() => void act(() => api.runRoutine(r.id), "Running it now.")}>
          Run now
        </button>
        <button className="linkish" disabled={busy} onClick={() => void act(() => api.updateRoutine(r.id, { enabled: !r.enabled }))}>
          {r.enabled ? "pause" : "resume"}
        </button>
        <button className="linkish" disabled={busy} onClick={() => void act(() => api.removeRoutine(r.id), "Removed.")}>
          remove
        </button>
      </div>
    </li>
  );
}

const TIMES: Array<[string, string]> = [
  ["Every morning", "0 13 * * *"],
  ["Every weekday morning", "0 13 * * 1-5"],
  ["Every afternoon", "0 20 * * *"],
  ["Every hour", "0 * * * *"],
  ["Every Monday", "0 14 * * 1"],
];

function CustomRoutine({ onAdd, busy }: { onAdd: (title: string, cron: string, prompt: string) => Promise<void>; busy: boolean }) {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [cron, setCron] = useState(TIMES[0]![1]);
  const [raw, setRaw] = useState(false);
  const err = cronError(cron);
  return (
    <div className="custom">
      <label>
        Name
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Check the school portal" />
      </label>
      <label>
        What to do
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} placeholder="Log in to the school portal and tell me about any new notices, grades or fees." />
      </label>
      <label>
        When
        {raw ? (
          <input value={cron} onChange={(e) => setCron(e.target.value)} />
        ) : (
          <select value={cron} onChange={(e) => setCron(e.target.value)}>
            {TIMES.map(([l, c]) => (
              <option key={c} value={c}>
                {l}
              </option>
            ))}
          </select>
        )}
      </label>
      <p className="fineprint">
        {err ?? describeCron(cron)} ·{" "}
        <button className="linkish" onClick={() => setRaw((r) => !r)}>
          {raw ? "pick from a list" : "exact time (cron, UTC)"}
        </button>
      </p>
      <button className="primary" disabled={busy || !title.trim() || !prompt.trim() || !!err} onClick={() => void onAdd(title.trim(), cron, prompt.trim())}>
        Add routine
      </button>
    </div>
  );
}
