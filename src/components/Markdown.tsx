import type { ReactNode } from "react";

// Minimal markdown for chat answers: headings, paragraphs, **bold**, `code`,
// bullet and numbered lists, and simple | tables |. Builds React elements
// (never raw HTML), so model output can't inject markup.

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2)
      return (
        <code key={i} className="rounded bg-zinc-100 px-1 text-[0.9em] dark:bg-zinc-800">
          {part.slice(1, -1)}
        </code>
      );
    return part;
  });
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
const isTableSep = (line: string) => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line.trim());
const isNumeric = (s: string) => /^[-+]?[$]?[\d,.]+[%KMk]?$/.test(s.replace(/\*\*/g, ""));

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    // Table: header row, separator row, body rows.
    if (line.trim().startsWith("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(line);
      const body: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) body.push(cells(lines[i++]));
      blocks.push(
        <div key={blocks.length} className="overflow-x-auto">
          <table className="my-1 min-w-full border-collapse text-xs">
            <thead>
              <tr>
                {head.map((h, k) => (
                  <th key={k} className="border-b border-zinc-300 px-2 py-1 text-left font-semibold dark:border-zinc-700">
                    {inline(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, r) => (
                <tr key={r} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
                  {row.map((c, k) => (
                    <td key={k} className={`px-2 py-1 align-top ${isNumeric(c) ? "text-right tabular-nums" : ""}`}>
                      {inline(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(
        <p key={blocks.length} className="font-semibold text-zinc-900 dark:text-zinc-50">
          {inline(heading[2])}
        </p>,
      );
      i++;
      continue;
    }
    const listItem = (l: string) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(l);
    if (listItem(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && listItem(lines[i])) items.push(lines[i++].replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ""));
      const ListTag = ordered ? "ol" : "ul";
      blocks.push(
        <ListTag key={blocks.length} className={`space-y-0.5 pl-5 ${ordered ? "list-decimal" : "list-disc"}`}>
          {items.map((it, k) => (
            <li key={k}>{inline(it)}</li>
          ))}
        </ListTag>,
      );
      continue;
    }
    // Paragraph: consecutive plain lines.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !listItem(lines[i]) && !lines[i].trim().startsWith("|") && !/^#{1,6}\s/.test(lines[i])) {
      para.push(lines[i++]);
    }
    blocks.push(<p key={blocks.length}>{inline(para.join(" "))}</p>);
  }
  return <div className="space-y-2">{blocks}</div>;
}
