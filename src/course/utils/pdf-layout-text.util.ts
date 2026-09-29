/**
 * Rebuilds PDF text line by line from pdf.js glyph positions:
 * fragments on one baseline form a line, a space is inserted only where there
 * is a visible gap, and wide gaps become cell separators (`| a | b |`, the
 * same row format as the DOCX reader). Plain item joining ("329 CSS - 3",
 * scrambled table cells) is what this replaces for course specifications.
 */

type Fragment = { x: number; y: number; width: number; size: number; str: string };

/** Gap (in font sizes) above which two fragments are separate table cells. */
const CELL_GAP_EM = 1.6;
/** Gap (in font sizes) above which fragments are separate words. */
const WORD_GAP_EM = 0.12;
/** Baseline difference (in font sizes) still treated as the same line. */
const SAME_LINE_EM = 0.45;

function joinLine(fragments: Fragment[]): string {
  const sorted = [...fragments].sort((a, b) => a.x - b.x);
  const cells: string[] = [];
  let current = '';
  let previous: Fragment | null = null;

  for (const fragment of sorted) {
    if (previous) {
      const gap = fragment.x - (previous.x + previous.width);
      const em = Math.max(previous.size, fragment.size, 1);
      if (gap > CELL_GAP_EM * em) {
        cells.push(current.trim());
        current = '';
      } else if (gap > WORD_GAP_EM * em && !current.endsWith(' ') && !fragment.str.startsWith(' ')) {
        current += ' ';
      }
    }
    current += fragment.str;
    previous = fragment;
  }
  cells.push(current.trim());

  const nonEmpty = cells.filter(Boolean);
  if (nonEmpty.length <= 1) return nonEmpty[0] ?? '';
  return `| ${nonEmpty.join(' | ')} |`;
}

function groupLines(fragments: Fragment[]): Fragment[][] {
  const sorted = [...fragments].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Array<{ y: number; size: number; items: Fragment[] }> = [];
  for (const fragment of sorted) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line.y - fragment.y) <= SAME_LINE_EM * Math.max(line.size, fragment.size, 1)) {
      line.items.push(fragment);
      continue;
    }
    lines.push({ y: fragment.y, size: fragment.size, items: [fragment] });
  }
  return lines.map((line) => line.items);
}

/** Layout-preserving text of every page ("--- Page N ---" separated); '' when the PDF has no text layer. */
export async function extractPdfLayoutText(buffer: Buffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    isEvalSupported: false,
  }).promise;

  const pages: string[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const fragments: Fragment[] = [];
      for (const item of content.items) {
        if (!('str' in item) || !('transform' in item)) continue;
        const str = String(item.str ?? '').replace(/\s+/g, ' ');
        if (!str.trim()) continue;
        const [a, b, c, d, x, y] = item.transform as number[];
        const size = Math.hypot(c, d) || Math.hypot(a, b) || Number(item.height) || 10;
        fragments.push({ x, y, width: Number(item.width) || 0, size, str });
      }
      const lines = groupLines(fragments)
        .map(joinLine)
        .filter((line) => line.trim());
      if (lines.length > 0) pages.push(`--- Page ${pageNumber} ---\n${lines.join('\n')}`);
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return pages.join('\n\n');
}
