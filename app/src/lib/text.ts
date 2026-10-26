/**
 * The little bit of markup the cards use: `**bold**` for the key term
 * (CARD_CONTRACT: "answer.core … with the key term in **bold**").
 *
 * Parsed into segments rather than turned into HTML, so card text can never
 * inject anything into the page: the screens build text nodes from these.
 */

export interface Segment {
  text: string;
  bold: boolean;
}

/**
 * 'De **EOQ** is …' → [{text:'De ', bold:false}, {text:'EOQ', bold:true}, …].
 * A lone `**` without a partner stays as plain text.
 */
export function boldSegments(text: string): Segment[] {
  const out: Segment[] = [];
  const source = String(text ?? '');
  let rest = source;
  while (rest.length > 0) {
    const open = rest.indexOf('**');
    if (open === -1) break;
    const close = rest.indexOf('**', open + 2);
    if (close === -1) break;
    if (open > 0) out.push({ text: rest.slice(0, open), bold: false });
    const inner = rest.slice(open + 2, close);
    if (inner.length > 0) out.push({ text: inner, bold: true });
    rest = rest.slice(close + 2);
  }
  if (rest.length > 0) out.push({ text: rest, bold: false });
  // Merge neighbours of the same kind (an empty bold pair leaves two plain parts).
  const merged: Segment[] = [];
  for (const s of out) {
    const last = merged[merged.length - 1];
    if (last && last.bold === s.bold) last.text += s.text;
    else merged.push({ ...s });
  }
  return merged;
}

/** The text without the markers, for copying and for aria labels. */
export function plainText(text: string): string {
  return boldSegments(text)
    .map((s) => s.text)
    .join('');
}

/** A cloze stem split around its blank: 'EOQ = √(2·D·____ / Cv)' → ['EOQ = √(2·D·', ' / Cv)']. */
export function clozeParts(stem: string): [string, string] | null {
  const m = /_{3,}/.exec(stem);
  if (!m) return null;
  return [stem.slice(0, m.index), stem.slice(m.index + m[0].length)];
}
