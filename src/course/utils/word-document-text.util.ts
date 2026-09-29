const CHECKED_BOX = '☒';
const UNCHECKED_BOX = '☐';

/** Wingdings / Symbol private-use glyphs Word uses for checkbox-like marks. */
const SYMBOL_CHAR_MAP: Record<string, string> = {
  F0FE: CHECKED_BOX,
  F0FD: CHECKED_BOX,
  F0FC: '✓',
  F0FB: '✗',
  F052: '✓',
  F078: CHECKED_BOX,
  F0A8: UNCHECKED_BOX,
  F06F: UNCHECKED_BOX,
  F071: UNCHECKED_BOX,
  F0A1: UNCHECKED_BOX,
};

const decodeXmlEntities = (value: string) =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) =>
      String.fromCodePoint(parseInt(dec, 10)),
    )
    .replace(/&amp;/g, '&');

const attr = (tag: string, name: string) =>
  new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];

const isTruthyVal = (tag: string) => {
  const val = attr(tag, 'w:val') ?? attr(tag, 'w14:val');
  return val === undefined || val === '1' || val === 'true' || val === 'on';
};

/**
 * Flattens WordprocessingML into plain text while keeping table structure:
 * every table row becomes one line `| cell | cell |`, and paragraphs inside a
 * cell are joined with ` <br> ` so a row never spills across lines.
 * Only visible text runs are emitted (field codes and deleted text are skipped).
 */
export function extractTextFromWordXml(xml: string): string {
  const tokenPattern =
    /<w:t(?:\s[^>]*?)?(?<!\/)>([\s\S]*?)<\/w:t>|<w:(?:instrText|delText)(?:\s[^>]*)?>[\s\S]*?<\/w:(?:instrText|delText)>|<w:checkBox>[\s\S]*?<\/w:checkBox>|<[^>]+>/g;

  let out = '';
  let cellDepth = 0;
  let rowOpen = false;
  let cellText = '';
  let paragraphHasText = false;
  // Top-level table bookkeeping so vertically merged cells repeat their text on every row they span.
  let columnIndex = 0;
  let cellSpan = 1;
  let cellMerge: 'restart' | 'continue' | null = null;
  let mergedColumnText = new Map<number, string>();

  const write = (text: string) => {
    if (!text) return;
    if (cellDepth > 0) cellText += text;
    else out += text;
    paragraphHasText = true;
  };

  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(xml))) {
    const token = match[0];

    if (match[1] !== undefined) {
      write(decodeXmlEntities(match[1]));
      continue;
    }
    if (token.startsWith('<w:instrText') || token.startsWith('<w:delText')) {
      continue;
    }
    if (token.startsWith('<w:checkBox>')) {
      const explicit = /<w:checked(?:\s[^>]*)?\/>/.exec(token);
      const fallback = /<w:default(?:\s[^>]*)?\/>/.exec(token);
      const checked = explicit
        ? isTruthyVal(explicit[0])
        : fallback
          ? attr(fallback[0], 'w:val') === '1'
          : false;
      write(checked ? CHECKED_BOX : UNCHECKED_BOX);
      continue;
    }

    const tagName = /^<\/?([\w:]+)/.exec(token)?.[1] ?? '';
    const closing = token.startsWith('</');

    switch (tagName) {
      case 'w:tab':
        write('\t');
        break;
      case 'w:br':
      case 'w:cr':
        if (cellDepth > 0) cellText += ' <br> ';
        else out += '\n';
        break;
      case 'w:sym': {
        const char = (attr(token, 'w:char') ?? '').toUpperCase();
        const mapped =
          SYMBOL_CHAR_MAP[char] ??
          SYMBOL_CHAR_MAP[`F0${char.slice(-2)}`] ??
          '';
        write(mapped);
        break;
      }
      case 'w:p':
        if (closing) {
          if (cellDepth > 0) {
            if (paragraphHasText) cellText += ' <br> ';
          } else {
            out += '\n';
          }
        } else {
          paragraphHasText = false;
        }
        break;
      case 'w:tbl':
        if (cellDepth === 0 && !closing) mergedColumnText = new Map();
        break;
      case 'w:tr':
        if (cellDepth > 0) break;
        if (closing) {
          if (rowOpen) out += '\n';
          rowOpen = false;
        } else {
          if (!out.endsWith('\n') && out) out += '\n';
          out += '|';
          rowOpen = true;
          columnIndex = 0;
        }
        break;
      case 'w:gridBefore':
        if (cellDepth === 0) {
          columnIndex += Number(attr(token, 'w:val') ?? 0) || 0;
        }
        break;
      case 'w:gridSpan':
        if (cellDepth === 1) cellSpan = Math.max(1, Number(attr(token, 'w:val') ?? 1) || 1);
        break;
      case 'w:vMerge':
        if (cellDepth === 1) {
          cellMerge = attr(token, 'w:val') === 'restart' ? 'restart' : 'continue';
        }
        break;
      case 'w:tc':
        if (closing) {
          cellDepth = Math.max(0, cellDepth - 1);
          if (cellDepth === 0) {
            let text = cellText
              .replace(/(?:\s*<br>\s*)+$/g, '')
              .replace(/^(?:\s*<br>\s*)+/g, '')
              .replace(/(?:\s*<br>\s*){2,}/g, ' <br> ')
              .replace(/[ \t]+/g, ' ')
              .trim();
            if (cellMerge === 'continue') {
              text = text || mergedColumnText.get(columnIndex) || '';
            } else if (cellMerge === 'restart') {
              mergedColumnText.set(columnIndex, text);
            } else {
              mergedColumnText.delete(columnIndex);
            }
            out += ` ${text} |`;
            cellText = '';
            columnIndex += cellSpan;
          } else {
            cellText += ' ; ';
          }
        } else {
          if (cellDepth === 0) {
            cellSpan = 1;
            cellMerge = null;
          }
          cellDepth += 1;
        }
        break;
      default:
        break;
    }
  }

  return out
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
