/** Markdown → React elements. Never HTML: the assistant's output is untrusted. */
import { parseMd, type Inline } from "../lib/md";

function Inlines({ kids }: { kids: Inline[] }) {
  return (
    <>
      {kids.map((k, i) => {
        switch (k.t) {
          case "text":
            return k.s;
          case "b":
            return (
              <strong key={i}>
                <Inlines kids={k.kids} />
              </strong>
            );
          case "i":
            return (
              <em key={i}>
                <Inlines kids={k.kids} />
              </em>
            );
          case "code":
            return <code key={i}>{k.s}</code>;
          case "a":
            return (
              <a key={i} href={k.href} target="_blank" rel="noopener">
                <Inlines kids={k.kids} />
              </a>
            );
        }
      })}
    </>
  );
}

export function Md({ src }: { src: string }) {
  return (
    <>
      {parseMd(src).map((block, i) =>
        block.t === "p" ? (
          <p key={i}>
            <Inlines kids={block.kids} />
          </p>
        ) : (
          <ul key={i}>
            {block.items.map((item, j) => (
              <li key={j}>
                <Inlines kids={item} />
              </li>
            ))}
          </ul>
        ),
      )}
    </>
  );
}
