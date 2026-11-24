// Splitting the Pipeline agent's summary for display. Pure text, no numbers changed, so it can be tested.

/** Splits "intro / 1. … / 2. … / outro" by line. Without numbered points it is all intro. */
export function splitSummary(text: string): { intro: string; points: string[]; outro: string[] } {
  const paras = text
    .replace(/\*\*(.+?)\*\*/g, "\u0000$1\u0001") // keep where Claude bolded, drop the markdown
    .split(/\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const isPoint = (x: string) => /^\d+[.)]\s/.test(x);
  const first = paras.findIndex(isPoint);
  if (first < 0) return { intro: paras.join(" "), points: [], outro: [] };
  let last = first;
  while (last + 1 < paras.length && isPoint(paras[last + 1])) last++;
  return {
    intro: paras.slice(0, first).join(" "),
    points: paras.slice(first, last + 1).map((x) => x.replace(/^\d+[.)]\s+/, "")),
    outro: paras.slice(last + 1),
  };
}

/**
 * The first phrase of a point and the rest: up to the first comma, colon, semicolon, dash or sentence
 * end (a decimal point such as "15.6%" doesn't end it). Short or unbroken points are all lead.
 */
export function firstPhrase(point: string): [string, string] {
  // Claude bolded its own lead ("**Overdue MQLs:** Kenji …"): use that.
  const bold = /^\u0000(.+?)\u0001\s*/.exec(point);
  if (bold) return [`${bold[1]} `, plain(point.slice(bold[0].length))];
  point = plain(point);
  const m = /^(.{8,90}?)([,:;]|\.(?=\s|$)| —| -)/.exec(point);
  if (!m) return [point, ""];
  const end = m[1].length + m[2].length;
  return [point.slice(0, end), point.slice(end)];
}

/** Text without the bold markers splitSummary keeps. */
export const plain = (s: string) => s.replace(/[\u0000\u0001]/g, "");
