/**
 * The sliver of markdown a brief's body_md may use — paragraphs, "- " bullet
 * lists, **bold**, *italic*, `code`, [links](https://…) — parsed to a small
 * AST the document view renders. The system prompt (spec.ts) promises the
 * agent uses nothing more; anything else degrades to plain text, never to
 * injected markup (no HTML pass-through anywhere).
 */

export type Inline =
  | { t: "text"; s: string }
  | { t: "b"; kids: Inline[] }
  | { t: "i"; kids: Inline[] }
  | { t: "code"; s: string }
  | { t: "a"; href: string; kids: Inline[] };

export type MdBlock = { t: "p"; kids: Inline[] } | { t: "ul"; items: Inline[][] };

/** Blocks separated by blank lines; a block of "- " lines is a list. */
export function parseMd(src: string): MdBlock[] {
  const out: MdBlock[] = [];
  for (const chunk of src.split(/\n[ \t]*\n+/)) {
    const lines = chunk.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length === 0) continue;
    if (lines.every((l) => /^[-*] /.test(l))) {
      out.push({ t: "ul", items: lines.map((l) => parseInline(l.slice(2).trim())) });
    } else {
      out.push({ t: "p", kids: parseInline(lines.join(" ")) });
    }
  }
  return out;
}

// Emphasis content must start and end on a non-space, so "2 * 3" stays text.
const CODE = /`([^`]+)`/;
const BOLD = /\*\*(\S(?:.*?\S)?)\*\*/;
const LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/;
const ITALIC = /(?<!\*)\*(\S(?:[^*]*\S)?)\*(?!\*)/;

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let rest = s;
  while (rest.length > 0) {
    const candidates: Array<{ index: number; len: number; node: Inline }> = [];
    const code = CODE.exec(rest);
    if (code) candidates.push({ index: code.index, len: code[0].length, node: { t: "code", s: code[1]! } });
    const bold = BOLD.exec(rest);
    if (bold) candidates.push({ index: bold.index, len: bold[0].length, node: { t: "b", kids: parseInline(bold[1]!) } });
    const link = LINK.exec(rest);
    if (link) candidates.push({ index: link.index, len: link[0].length, node: { t: "a", href: link[2]!, kids: parseInline(link[1]!) } });
    const italic = ITALIC.exec(rest);
    if (italic) candidates.push({ index: italic.index, len: italic[0].length, node: { t: "i", kids: parseInline(italic[1]!) } });
    if (candidates.length === 0) {
      out.push({ t: "text", s: rest });
      break;
    }
    candidates.sort((a, b) => a.index - b.index || b.len - a.len);
    const first = candidates[0]!;
    if (first.index > 0) out.push({ t: "text", s: rest.slice(0, first.index) });
    out.push(first.node);
    rest = rest.slice(first.index + first.len);
  }
  return out;
}
