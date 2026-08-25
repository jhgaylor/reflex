/**
 * Just enough cron to be honest with the user.
 *
 * Fountain runs these in UTC, and a schedule that silently never fires is the
 * worst outcome for an ambient tool — so anything typed here is validated
 * before it is saved, and described back in English so a wrong guess is
 * obvious before it costs a week of silence.
 */

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

interface FieldSpec {
  min: number;
  max: number;
  name: string;
}

const FIELDS: FieldSpec[] = [
  { min: 0, max: 59, name: "minute" },
  { min: 0, max: 23, name: "hour" },
  { min: 1, max: 31, name: "day of month" },
  { min: 1, max: 12, name: "month" },
  { min: 0, max: 7, name: "day of week" },
];

/** Null when the expression is usable; otherwise why it is not. */
export function cronError(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return "A cron expression has five fields: minute hour day-of-month month day-of-week.";
  for (let i = 0; i < 5; i++) {
    const spec = FIELDS[i]!;
    const err = fieldError(parts[i]!, spec);
    if (err) return err;
  }
  return null;
}

function fieldError(field: string, spec: FieldSpec): string | null {
  for (const term of field.split(",")) {
    if (term === "") return `Empty ${spec.name} field.`;
    const [range, step] = term.split("/");
    if (step !== undefined && (!/^\d+$/.test(step) || Number(step) === 0)) {
      return `"${step}" is not a usable step for the ${spec.name}.`;
    }
    if (range === "*") continue;
    const bounds = range!.split("-");
    if (bounds.length > 2) return `"${term}" is not a valid ${spec.name}.`;
    for (const b of bounds) {
      if (!/^\d+$/.test(b)) return `"${b}" is not a number in the ${spec.name} field.`;
      const n = Number(b);
      if (n < spec.min || n > spec.max) return `The ${spec.name} must be ${spec.min}–${spec.max}; got ${n}.`;
    }
    if (bounds.length === 2 && Number(bounds[0]) > Number(bounds[1])) {
      return `"${term}" runs backwards for the ${spec.name}.`;
    }
  }
  return null;
}

/**
 * A plain-English reading of the common shapes, falling back to the raw
 * expression when it is more complex than a sentence should describe.
 */
export function describeCron(expr: string): string {
  if (cronError(expr)) return expr;
  const [min, hour, dom, mon, dow] = expr.trim().split(/\s+/) as [string, string, string, string, string];

  const everyN = (f: string) => (/^\*\/(\d+)$/.test(f) ? Number(/^\*\/(\d+)$/.exec(f)![1]) : null);
  const hourStep = everyN(hour);
  if (hourStep && min !== "*" && dom === "*" && mon === "*" && dow === "*") {
    return `Every ${hourStep} hours, at ${pad(min)} past`;
  }
  const minStep = everyN(min);
  if (minStep && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    return `Every ${minStep} minutes`;
  }
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour)) return expr;

  const at = `${pad(hour)}:${pad(min)} UTC`;
  const onDays = dow === "*" ? null : dayList(dow);
  if (dom === "*" && mon === "*") {
    if (!onDays) return `Every day at ${at}`;
    return `${onDays} at ${at}`;
  }
  if (mon === "*" && /^\d+$/.test(dom) && dow === "*") {
    return `Monthly, on the ${ordinal(Number(dom))} at ${at}`;
  }
  if (/^\d+$/.test(mon) && /^\d+$/.test(dom)) {
    return `${MONTHS[Number(mon) - 1]} ${ordinal(Number(dom))} at ${at}`;
  }
  return expr;
}

function dayList(dow: string): string | null {
  const names: string[] = [];
  for (const term of dow.split(",")) {
    const bounds = term.split("-").map(Number);
    if (bounds.some((n) => Number.isNaN(n))) return null;
    const from = bounds[0]!;
    const to = bounds.length === 2 ? bounds[1]! : from;
    for (let d = from; d <= to; d++) names.push(DAYS[d % 7]!);
  }
  if (names.length === 0) return null;
  if (names.length === 7) return "Every day";
  if (names.length === 5 && ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].every((d) => names.includes(d))) {
    return "Every weekday";
  }
  if (names.length === 1) return `Every ${names[0]}`;
  return `Every ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function pad(n: string): string {
  return n.padStart(2, "0");
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** "in 3 hours" / "6 days ago" — for last_run_at and next_run_at. */
export function relativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return "never";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const delta = then - now;
  const ahead = delta > 0;
  const secs = Math.abs(delta) / 1000;
  const units: Array<[number, string]> = [
    [60, "second"],
    [60, "minute"],
    [24, "hour"],
    [7, "day"],
    [4.35, "week"],
    [12, "month"],
  ];
  let value = secs;
  let unit = "second";
  for (const [step, name] of units) {
    if (value < step) {
      unit = name;
      break;
    }
    value /= step;
    unit = name === "month" ? "year" : nextUnit(name);
  }
  const n = Math.max(1, Math.round(value));
  const label = `${n} ${unit}${n === 1 ? "" : "s"}`;
  return ahead ? `in ${label}` : `${label} ago`;
}

function nextUnit(name: string): string {
  switch (name) {
    case "second":
      return "minute";
    case "minute":
      return "hour";
    case "hour":
      return "day";
    case "day":
      return "week";
    case "week":
      return "month";
    default:
      return "year";
  }
}
