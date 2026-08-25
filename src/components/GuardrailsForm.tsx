import type { Guardrails } from "../../shared/spec";

const ROWS: Array<{ key: keyof Guardrails; title: string; hint: string }> = [
  { key: "askBeforeSpending", title: "Ask before spending money", hint: "Purchases, bookings with a card, paid upgrades." },
  { key: "askBeforeSending", title: "Ask before messaging anyone", hint: "Emails and texts to anyone other than you. It shows you the draft first." },
  { key: "askBeforeCancelling", title: "Ask before cancelling anything", hint: "Cancellations, deletions, unsubscribes." },
];

export function GuardrailsForm({ value, onChange }: { value: Guardrails; onChange: (g: Guardrails) => void }) {
  return (
    <div className="rails">
      {ROWS.map((r) => (
        <label key={r.key} className="rail">
          <input type="checkbox" checked={value[r.key]} onChange={(e) => onChange({ ...value, [r.key]: e.target.checked })} />
          <span>
            <b>{r.title}</b>
            <small>{r.hint}</small>
          </span>
        </label>
      ))}
    </div>
  );
}
