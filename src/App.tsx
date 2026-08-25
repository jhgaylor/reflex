/**
 * Reflex: the page. Boot → welcome (sign in) → setup (a guided first run) →
 * home. Everything it shows comes from the Reflex server in the owner's
 * words; the live stream keeps the thread, jobs and bell current.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AssistantView, JobView, Me, NotificationView, ThreadView } from "../shared/api";
import { api, ApiError, openStream } from "./lib/api";
import { completeLoginIfCallback, isCallback } from "./lib/oauth";
import { Welcome } from "./components/Welcome";
import { Setup } from "./components/Setup";
import { Home } from "./components/Home";
import { Routines } from "./components/Routines";
import { Connections } from "./components/Connections";
import { Memory } from "./components/Memory";
import { Settings } from "./components/Settings";
import { Bell } from "./components/Bell";

export type Tab = "home" | "routines" | "connections" | "memory" | "settings";
type Phase = "boot" | "welcome" | "setup" | "home";

const NONE: AssistantView = { state: "none", label: "", hired: false };

export function App() {
  const [phase, setPhase] = useState<Phase>("boot");
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState<Tab>("home");
  const [welcomeError, setWelcomeError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [thread, setThread] = useState<ThreadView | null>(null);
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [notifications, setNotifications] = useState<NotificationView[]>([]);
  const [assistant, setAssistant] = useState<AssistantView>(NONE);
  const [live, setLive] = useState(false);

  const say = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 6000);
  }, []);

  const place = useCallback((m: Me) => {
    setMe(m);
    if (!m.signedIn) setPhase("welcome");
    else if (m.setupStep && m.setupStep !== "done") setPhase("setup");
    else setPhase("home");
    if (m.assistant) setAssistant(m.assistant);
  }, []);

  // ── boot ────────────────────────────────────────────────────────────────
  useEffect(() => {
    void (async () => {
      try {
        if (isCallback()) {
          const cb = await completeLoginIfCallback();
          if (cb) {
            place(await api.session(cb.apiKey, cb.baseUrl));
            return;
          }
        }
        place(await api.me());
      } catch (err) {
        setWelcomeError(err instanceof Error ? err.message : String(err));
        setPhase("welcome");
      }
    })();
  }, [place]);

  // ── data ────────────────────────────────────────────────────────────────
  const reloadThread = useCallback(async () => {
    try {
      const t = await api.thread();
      setThread(t);
      setAssistant(t.assistant);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setPhase("welcome");
    }
  }, []);
  const reloadJobs = useCallback(() => api.jobs().then(setJobs).catch(() => undefined), []);
  const reloadNotifications = useCallback(() => api.notifications().then(setNotifications).catch(() => undefined), []);

  useEffect(() => {
    if (phase !== "home") return;
    void reloadThread();
    void reloadJobs();
    void reloadNotifications();
  }, [phase, reloadThread, reloadJobs, reloadNotifications]);

  // ── live ────────────────────────────────────────────────────────────────
  const threadRef = useRef(thread);
  threadRef.current = thread;
  useEffect(() => {
    if (phase !== "home") return;
    const close = openStream(
      (e) => {
        switch (e.type) {
          case "hello":
            void reloadThread();
            break;
          case "assistant":
            setAssistant(e.assistant);
            break;
          case "turn":
            void reloadThread();
            if (e.state !== "started") void reloadJobs();
            break;
          case "text":
            setThread((t) => {
              if (!t) return t;
              const turns = t.turns.map((turn) => (turn.id === e.turnId ? { ...turn, reply: turn.reply + e.text } : turn));
              return { ...t, turns };
            });
            break;
          case "step":
            setThread((t) => {
              if (!t) return t;
              const turns = t.turns.map((turn) => (turn.id === e.turnId ? { ...turn, steps: [...turn.steps, e.text] } : turn));
              return { ...t, turns };
            });
            break;
          case "jobs":
            void reloadJobs();
            break;
          case "notify":
            setNotifications((ns) => [e.notification, ...ns.filter((n) => n.id !== e.notification.id)]);
            break;
        }
      },
      (state) => {
        setLive(state);
        if (state) void reloadThread();
      },
    );
    return close;
  }, [phase, reloadThread, reloadJobs]);

  // ── actions ─────────────────────────────────────────────────────────────
  const send = useCallback(
    async (text: string) => {
      try {
        const r = await api.send(text);
        if (r.queued) say("Reflex is in the middle of something. Your message will go as soon as it is free.");
        await reloadThread();
      } catch (err) {
        say(err instanceof Error ? err.message : String(err));
      }
    },
    [reloadThread, say],
  );

  const stop = useCallback(async () => {
    try {
      const r = await api.stop();
      if (r.mode === "fresh") say("Reflex was stuck, so it started a fresh thread. It kept its computer and its notes.");
      else if (r.mode === "stopped") say("Stopped.");
      await reloadThread();
    } catch (err) {
      say(err instanceof Error ? err.message : String(err));
    }
  }, [reloadThread, say]);

  const signOut = useCallback(async () => {
    await api.signOut().catch(() => undefined);
    setMe(null);
    setThread(null);
    setJobs([]);
    setNotifications([]);
    setAssistant(NONE);
    setPhase("welcome");
  }, []);

  // ── render ──────────────────────────────────────────────────────────────
  if (phase === "boot") return <div className="boot" />;
  if (phase === "welcome" || !me) return <Welcome error={welcomeError} />;
  if (phase === "setup")
    return (
      <Setup
        me={me}
        onDone={(m) => {
          place(m);
          setTab("home");
        }}
        onSignOut={signOut}
        say={say}
      />
    );

  const unread = notifications.filter((n) => !n.read).length;

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="mark" />
          Reflex
        </div>
        <Presence assistant={assistant} live={live} />
        <div className="grow" />
        <Bell
          items={notifications}
          unread={unread}
          onOpen={() => {
            if (unread) void api.markNotificationsRead().then(reloadNotifications);
          }}
        />
      </header>

      {toast && <div className="toast">{toast}</div>}

      <main className="page">
        {tab === "home" && <Home thread={thread} jobs={jobs} assistant={assistant} onSend={send} onStop={() => void stop()} onDrop={(k) => api.dropJob(k).then(reloadJobs).catch((e) => say(e.message))} />}
        {tab === "routines" && <Routines say={say} />}
        {tab === "connections" && <Connections say={say} />}
        {tab === "memory" && <Memory say={say} />}
        {tab === "settings" && <Settings me={me} onUpdated={setMe} onSignOut={signOut} say={say} />}
      </main>

      <nav className="tabs">
        {(
          [
            ["home", "Home"],
            ["routines", "Routines"],
            ["connections", "Connections"],
            ["memory", "Memory"],
            ["settings", "Settings"],
          ] as Array<[Tab, string]>
        ).map(([id, label]) => (
          <button key={id} className={tab === id ? "tab active" : "tab"} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}

function Presence({ assistant, live }: { assistant: AssistantView; live: boolean }) {
  return (
    <div className={`presence ${assistant.state}`} title={live ? "live" : "reconnecting"}>
      <span className="pip" />
      <span>{assistant.label || "…"}</span>
    </div>
  );
}
