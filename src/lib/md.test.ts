import { describe, expect, test } from "bun:test";
import { parseInline, parseMd } from "./md";

describe("parseMd", () => {
  test("paragraphs split on blank lines; wrapped lines join", () => {
    expect(parseMd("One long\nparagraph.\n\nTwo.")).toEqual([
      { t: "p", kids: [{ t: "text", s: "One long paragraph." }] },
      { t: "p", kids: [{ t: "text", s: "Two." }] },
    ]);
  });

  test("a block of dashes is a list", () => {
    expect(parseMd("- first\n- second")).toEqual([
      { t: "ul", items: [[{ t: "text", s: "first" }], [{ t: "text", s: "second" }]] },
    ]);
  });

  test("empty input renders nothing", () => {
    expect(parseMd("")).toEqual([]);
    expect(parseMd("\n\n")).toEqual([]);
  });
});

describe("parseInline", () => {
  test("bold, italic, code, links", () => {
    expect(parseInline("a **b** *i* `c` [t](https://x.example/p) end")).toEqual([
      { t: "text", s: "a " },
      { t: "b", kids: [{ t: "text", s: "b" }] },
      { t: "text", s: " " },
      { t: "i", kids: [{ t: "text", s: "i" }] },
      { t: "text", s: " " },
      { t: "code", s: "c" },
      { t: "text", s: " " },
      { t: "a", href: "https://x.example/p", kids: [{ t: "text", s: "t" }] },
      { t: "text", s: " end" },
    ]);
  });

  test("italic nests inside bold", () => {
    expect(parseInline("**bold *and italic* inside**")).toEqual([
      {
        t: "b",
        kids: [{ t: "text", s: "bold " }, { t: "i", kids: [{ t: "text", s: "and italic" }] }, { t: "text", s: " inside" }],
      },
    ]);
  });

  test("stray asterisks around spaces stay text", () => {
    expect(parseInline("2 * 3 = 6 and 4 * 5")).toEqual([{ t: "text", s: "2 * 3 = 6 and 4 * 5" }]);
  });

  test("non-http link syntax degrades to text", () => {
    expect(parseInline("[x](javascript:alert(1))")).toEqual([{ t: "text", s: "[x](javascript:alert(1))" }]);
  });
});
