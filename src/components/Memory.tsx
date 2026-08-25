/** Memory: what Reflex knows about you, editable. Short facts; the long notes live on its computer. */
import { useEffect, useState } from "react";
import type { MemoryView } from "../../shared/api";
import { api } from "../lib/api";
import { relativeTime } from "../lib/cron";

export function Memory({ say }: { say: (s: string) => void }) {
  const [items, setItems] = useState<MemoryView[] | null>(null);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");

  const load = () => api.memory().then(setItems).catch((e: Error) => say(e.message));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = (k: string, v: string) =>
    api
      .setMemory(k, v)
      .then(() => load())
      .catch((e: Error) => say(e.message));

  return (
    <div className="memory">
      <h2>What Reflex knows</h2>
      <p className="lede">It picks these up as you go. Fix anything wrong; remove anything it should forget.</p>
      {items === null ? (
        <p className="fineprint">Loading…</p>
      ) : items.length === 0 ? (
        <p className="fineprint">Nothing yet. Tell it about yourself in the thread, or add a fact here.</p>
      ) : (
        <ul className="facts">
          {items.map((m) => (
            <Fact key={m.key} m={m} onSave={(v) => save(m.key, v)} onForget={() => api.forget(m.key).then(load).catch((e: Error) => say(e.message))} />
          ))}
        </ul>
      )}
      <div className="account-form">
        <label>
          Fact
          <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="home_airport" />
        </label>
        <label>
          Value
          <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="DEN" />
        </label>
        <button
          className="ghost"
          disabled={!key.trim() || !value.trim()}
          onClick={() => {
            void save(key.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_"), value.trim());
            setKey("");
            setValue("");
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}

function Fact({ m, onSave, onForget }: { m: MemoryView; onSave: (v: string) => Promise<void>; onForget: () => void }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(m.value);
  return (
    <li className="fact">
      <div className="fact-main">
        <span className="fact-key">{m.key.replace(/_/g, " ")}</span>
        {editing ? (
          <input
            value={v}
            autoFocus
            onChange={(e) => setV(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                void onSave(v).then(() => setEditing(false));
              }
              if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <span className="fact-value">{m.value}</span>
        )}
      </div>
      <div className="fact-side">
        <span className="fineprint">{relativeTime(m.updatedAt)}</span>
        <button className="linkish" onClick={() => setEditing((e) => !e)}>
          {editing ? "cancel" : "edit"}
        </button>
        <button className="linkish" onClick={onForget}>
          forget
        </button>
      </div>
    </li>
  );
}
