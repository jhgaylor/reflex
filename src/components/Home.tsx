/**
 * Home: the jobs board on top, the thread underneath, a composer that feels
 * like texting. The thread is one conversation, on purpose.
 */
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { AssistantView, JobView, ThreadView, TurnView } from "../../shared/api";
import { STATUS_LABEL, type JobStatus } from "../../shared/protocol";
import { STARTER_JOBS } from "../../shared/spec";
import { relativeTime } from "../lib/cron";
import { Md } from "./Md";

const ORDER: JobStatus[] = ["needs-you", "working", "queued", "done", "dropped"];

export function Home(props: {
  thread: ThreadView | null;
  jobs: JobView[];
  assistant: AssistantView;
  onSend: (text: string) => Promise<void>;
  onStop: () => void;
  onDrop: (key: string) => void;
}) {
  const { thread, jobs, assistant } = props;
  const working = assistant.state === "working" || assistant.state === "waking";
  const open = jobs.filter((j) => j.status !== "done" && j.status !== "dropped").sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
  const closed = jobs.filter((j) => j.status === "done" || j.status === "dropped").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const [showClosed, setShowClosed] = useState(false);
  const turns = thread?.turns ?? [];
  const empty = turns.length === 0 && jobs.length === 0;

  return (
    <div className="home">
      <section className="board">
        <div className="board-head">
          <h2>Jobs</h2>
          {closed.length > 0 && (
            <button className="linkish" onClick={() => setShowClosed((s) => !s)}>
              {showClosed ? "hide finished" : `${closed.length} finished`}
            </button>
          )}
        </div>
        {open.length === 0 && !showClosed && <p className="fineprint">Nothing in flight. Ask for something below.</p>}
        <ul className="jobs">
          {open.map((j) => (
            <Job key={j.key} job={j} onDrop={props.onDrop} />
          ))}
          {showClosed && closed.map((j) => <Job key={j.key} job={j} onDrop={props.onDrop} />)}
        </ul>
      </section>

      <section className="thread">
        {empty && (
          <div className="empty">
            <h2>What can Reflex do for you?</h2>
            <div className="starters">
              {STARTER_JOBS.map((s) => (
                <button key={s.title} className="starter" onClick={() => void props.onSend(s.prompt)}>
                  {s.title}
                </button>
              ))}
            </div>
          </div>
        )}
        {turns.map((t) => (
          <Turn key={t.id} turn={t} />
        ))}
        {thread && thread.queued > 0 && (
          <div className="fineprint center">
            {thread.queued} message{thread.queued === 1 ? "" : "s"} waiting for Reflex to finish
          </div>
        )}
        <Composer working={working} onSend={props.onSend} onStop={props.onStop} />
      </section>
    </div>
  );
}

function Job({ job, onDrop }: { job: JobView; onDrop: (key: string) => void }) {
  const live = job.status !== "done" && job.status !== "dropped";
  return (
    <li className={`job ${job.status}`}>
      <div className="job-main">
        <span className="pill">{STATUS_LABEL[job.status]}</span>
        <b>{job.title}</b>
        {job.note && <span className="job-note">{job.note}</span>}
      </div>
      <div className="job-side">
        <span className="fineprint">{relativeTime(job.updatedAt)}</span>
        {live && (
          <button className="linkish" onClick={() => onDrop(job.key)} title="Tell Reflex to stop working on this">
            drop
          </button>
        )}
      </div>
    </li>
  );
}

function Turn({ turn }: { turn: TurnView }) {
  const running = turn.status === "running" || turn.status === "pending";
  const [showSteps, setShowSteps] = useState(false);
  const lastStep = turn.steps[turn.steps.length - 1];
  const steps = collapse(turn.steps);
  return (
    <div className="turn">
      {turn.via === "reflex" ? (
        <div className="fineprint center">Reflex kept going on its own · {relativeTime(turn.at)}</div>
      ) : (
        <div className={`bubble you ${turn.via}`}>
          {turn.via !== "you" && <span className="via">{turn.via === "routine" ? "routine" : `by ${turn.via}`}</span>}
          <p>{turn.prompt.replace(/^\[via \w+\]\s*/, "")}</p>
          <time className="fineprint">{relativeTime(turn.at)}</time>
        </div>
      )}
      {(turn.reply || running || turn.status === "failed") && (
        <div className={`bubble them${running ? " running" : ""}`}>
          {turn.reply ? <Md src={turn.reply} /> : running ? <p className="fineprint">{lastStep ?? "On it…"}</p> : null}
          {turn.status === "failed" && !turn.reply && <p className="fineprint">Reflex hit a problem with this one and stopped. Ask again, or ask it what went wrong.</p>}
          {steps.length > 0 && (
            <div className="steps">
              <button className="linkish" onClick={() => setShowSteps((s) => !s)}>
                {showSteps ? "hide what it did" : `${steps.length} step${steps.length === 1 ? "" : "s"}`}
              </button>
              {showSteps && (
                <ul>
                  {steps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** "Searched the web" six times in a row reads as one line with a count. */
function collapse(steps: string[]): string[] {
  const out: Array<{ text: string; n: number }> = [];
  for (const s of steps) {
    const last = out[out.length - 1];
    if (last && last.text === s) last.n++;
    else out.push({ text: s, n: 1 });
  }
  return out.map((s) => (s.n > 1 ? `${s.text} (×${s.n})` : s.text));
}

function Composer({ working, onSend, onStop }: { working: boolean; onSend: (t: string) => Promise<void>; onStop: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [text]);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setText("");
    await onSend(t);
    setBusy(false);
    ref.current?.focus();
  };

  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <form className="composer" onSubmit={submit}>
      <textarea ref={ref} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={key} rows={1} placeholder="Text Reflex…" />
      {working ? (
        <button type="button" className="ghost" onClick={onStop} title="Stop what it is doing right now">
          Stop
        </button>
      ) : null}
      <button type="submit" className="primary" disabled={!text.trim() || busy}>
        Send
      </button>
    </form>
  );
}
