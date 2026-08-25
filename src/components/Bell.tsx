import { useEffect, useRef, useState } from "react";
import type { NotificationView } from "../../shared/api";
import { relativeTime } from "../lib/cron";

export function Bell({ items, unread, onOpen }: { items: NotificationView[]; unread: number; onOpen: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div className="bell" ref={ref}>
      <button
        className="bell-btn"
        aria-label="Notifications"
        onClick={() => {
          setOpen((o) => !o);
          if (!open) onOpen();
        }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        {unread > 0 && <span className="badge">{unread}</span>}
      </button>
      {open && (
        <div className="bell-menu">
          <div className="bell-head">What Reflex told you</div>
          {items.length === 0 && <p className="fineprint pad">Nothing yet. When Reflex finishes something or needs you, it shows up here (and on your phone, if texting is on).</p>}
          {items.slice(0, 30).map((n) => (
            <div key={n.id} className={`note ${n.kind}${n.read ? "" : " unread"}`}>
              <div className="note-text">{n.text}</div>
              <div className="fineprint">{relativeTime(n.at)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
