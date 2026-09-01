/**
 * Memory: the person's brain, inspectable. Recent entries by default, search
 * on top of it (engram's hybrid search server-side), each entry with what the
 * assistant filed it as and how strongly it is currently held. Forgetting
 * archives the entry — it leaves the assistant's view but stays auditable.
 */
import { useEffect, useRef, useState } from "react";
import type { MemoryEntryView, MemoryPage } from "../../shared/api";
import { api } from "../lib/api";
import { relativeTime } from "../lib/cron";

const CATEGORIES = ["context", "person", "insight", "decision", "idea"];

export function Memory({ say }: { say: (s: string) => void }) {
  const [page, setPage] = useState<MemoryPage | null>(null);
  const [q, setQ] = useState("");
  const [content, setContent] = useState("");
  const [category, setCategory] = useState("context");
  const [busy, setBusy] = useState(false);
  const debounce = useRef<number | null>(null);

  const load = (query: string) =>
    api
      .memory(query.trim() || undefined)
      .then(setPage)
      .catch((e: Error) => say(e.message));

  useEffect(() => {
    void load("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const search = (value: string) => {
    setQ(value);
    if (debounce.current) window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => void load(value), 350);
  };

  const remember = async () => {
    setBusy(true);
    try {
      await api.remember(content.trim(), category);
      setContent("");
      await load(q);
    } catch (e) {
      say(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const forget = async (e: MemoryEntryView) => {
    if (!e.id) return;
    try {
      await api.forget(e.id);
      await load(q);
    } catch (err) {
      say(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="memory">
      <h2>What Reflex knows</h2>
      <p className="lede">Everything it has picked up, newest first. It fades unless it keeps mattering; forget anything it should not hold.</p>

      {page?.ready && (
        <input className="memory-search" value={q} onChange={(e) => search(e.target.value)} placeholder="Search its memory…" />
      )}

      {page === null ? (
        <p className="fineprint">Loading…</p>
      ) : !page.ready ? (
        <p className="fineprint">{page.reason ?? "Memory is not set up yet."}</p>
      ) : page.entries.length === 0 ? (
        <p className="fineprint">{q.trim() ? "Nothing matches that." : "Nothing yet. Tell it about yourself in the thread, or add something below."}</p>
      ) : (
        <ul className="entries">
          {page.entries.map((e, i) => (
            <Entry key={e.id ?? i} e={e} onForget={() => void forget(e)} />
          ))}
        </ul>
      )}

      {page?.ready && (
        <div className="account-form">
          <label>
            Remember
            <input value={content} onChange={(e) => setContent(e.target.value)} placeholder="My home airport is DEN" />
          </label>
          <label>
            As
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <button className="ghost" disabled={busy || !content.trim()} onClick={() => void remember()}>
            Add
          </button>
        </div>
      )}
    </div>
  );
}

function Entry({ e, onForget }: { e: MemoryEntryView; onForget: () => void }) {
  return (
    <li className="entry">
      <div className="entry-main">
        <div className="entry-meta">
          <span className={`chip chip-${e.category}`}>{e.category.replace(/_/g, " ")}</span>
          {e.source && e.source !== "human" && <span className="fineprint">{e.source === "import" ? "imported" : e.source === "agent_brain" ? "Reflex" : e.source}</span>}
          {e.tags.filter((t) => t !== "reflex-import").map((t) => (
            <span key={t} className="chip chip-tag">
              {t}
            </span>
          ))}
        </div>
        <span className="entry-content">{e.content}</span>
      </div>
      <div className="entry-side">
        {e.strength !== null && <Strength value={e.strength} />}
        {e.at && <span className="fineprint">{relativeTime(e.at)}</span>}
        {e.id && (
          <button className="linkish" onClick={onForget}>
            forget
          </button>
        )}
      </div>
    </li>
  );
}

/** How strongly this is currently held; engram decays it unless reinforced. */
function Strength({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <span className="strength" title={`memory strength ${Math.round(pct)}%`}>
      <span className="strength-bar" style={{ width: `${pct}%` }} />
    </span>
  );
}
