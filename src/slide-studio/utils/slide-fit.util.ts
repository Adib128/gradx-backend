import type { StudioSlide } from '../slide-studio.types';

/**
 * Predicts whether a slide's text fits the 16:9 stage the frontend renders
 * (`SlideStage` at 1100 × 619 px, 16 px body text). It mirrors the stage's
 * layout rules (figure beside vs. under the text, block paddings, gaps) and
 * wraps words greedily with average glyph widths, so the agents can fix
 * overflowing slides before anyone sees them.
 */

const STAGE_W = 1100;
const STAGE_H = 619;
const PAD_X = 40;
const BODY_PAD_Y = 40;
const FOOTER_H = 33;
const FONT = 16;
const LINE = FONT * 1.625;
/** `text-sm` keeps its 1.43 line-height ratio when the stage forces 16 px text. */
const TIGHT_LINE = FONT * (1.25 / 0.875);
const TITLE_LINE = 28 * 1.375;
const BLOCK_GAP = 12;
const BULLET_GAP = 10;
const BULLET_INDENT = 22;
const FIGURE_GAP = 24;
const WIDE_ASPECT = 1.9;
/** Code block: 0.85em monospace with a language header and an optional output panel. */
const CODE_FONT = FONT * 0.85;
const CODE_LINE = CODE_FONT * 1.55;
const CODE_CHAR = CODE_FONT * 0.6;
const CODE_CHROME = 2 + 27 + 20;
/** Horizontal padding plus the line-number gutter. */
const CODE_GUTTER = 24 + CODE_FONT * 2.2 + 12 + 2;
const OUTPUT_FONT = FONT * 0.8;
const OUTPUT_LINE = OUTPUT_FONT * 1.5;
const OUTPUT_CHROME = 1 + 16 + FONT * 0.65 * 1.5 + 4;

const PLAIN_RE = /\*\*/g;
const ARABIC_RE = /[\u0600-\u06FF]/;

export type SlideFit = {
  /** Text height ÷ room for text; above 1 the slide overflows. */
  fill: number;
  arrangement: 'text' | 'side' | 'stack' | 'fill';
  /** Words that must go for the text to fit (0 when it fits). */
  excessWords: number;
  /** On-stage size of diagram labels in px (body text is 16), null without a flowchart. */
  diagramLabelPx: number | null;
};

const plain = (value: unknown) =>
  typeof value === 'string' ? value.replace(PLAIN_RE, '').trim() : '';

function glyphWidth(char: string, size: number) {
  if (char === ' ') return size * 0.27;
  if (/[il.,:;'|!()[\]]/.test(char)) return size * 0.3;
  if (/[mwMW@%]/.test(char)) return size * 0.82;
  if (/[A-Z0-9]/.test(char)) return size * 0.64;
  if (ARABIC_RE.test(char)) return size * 0.5;
  return size * 0.54;
}

/** Lines a paragraph needs at `width` px, wrapping on spaces like the browser. */
export function wrapLines(text: string, width: number, size = FONT): number {
  const value = plain(text);
  if (!value) return 0;
  const space = glyphWidth(' ', size);
  let lines = 1;
  let used = 0;
  for (const word of value.split(/\s+/)) {
    let w = 0;
    for (const char of word) w += glyphWidth(char, size);
    if (w > width) {
      // Long tokens (paths, code) break anywhere.
      const extra = Math.ceil((used + w) / width) - 1;
      lines += extra;
      used = (used + w) % width;
      continue;
    }
    if (used && used + space + w > width) {
      lines += 1;
      used = w;
    } else {
      used += (used ? space : 0) + w;
    }
  }
  return lines;
}

function headerHeight(slide: StudioSlide) {
  const titleLines = Math.min(3, wrapLines(String(slide.title ?? ''), STAGE_W - 2 * PAD_X - 140, 28));
  return (
    24 +
    (slide.sectionLabel || slide.cloCode || slide.bloomLevel ? 22 : 0) +
    Math.max(1, titleLines) * TITLE_LINE +
    (plain(slide.subtitle) ? 28 : 0) +
    16
  );
}

function bulletsHeight(items: unknown[], width: number, line = LINE, gap = BULLET_GAP) {
  const texts = items.map(plain).filter(Boolean);
  if (!texts.length) return 0;
  return (
    texts.reduce((sum, text) => sum + wrapLines(text, width - BULLET_INDENT) * line, 0) +
    gap * (texts.length - 1)
  );
}

const EDGE_RE = /\s*(?:<?[-=.]{2,}>?|<?-\.+->?|~~~)\s*(?:\|[^|]*\|\s*)?/;

/** Nodes, edges and label lengths of a Mermaid flowchart. */
export function parseFlowchart(code: string) {
  const labels = new Map<string, number>();
  const edges: Array<[string, string]> = [];
  for (const raw of code.split('\n').slice(1)) {
    const line = raw.trim();
    if (!line || /^(subgraph|end|style|classDef|class|click|direction|%%)/i.test(line)) continue;
    const parts = line
      .replace(/"[^"]*"/g, (match) => `"${'x'.repeat(Math.max(0, match.length - 2))}"`)
      .split(EDGE_RE)
      .map((part) => part.trim())
      .filter(Boolean);
    const ids: string[] = [];
    for (const part of parts) {
      for (const node of part.split('&')) {
        const match = /^([A-Za-z_][\w-]*)\s*(.*)$/.exec(node.trim());
        if (!match) continue;
        const [, id, shape] = match;
        const text = shape.replace(/^[[({>/\\]+|[\])}/\\]+$/g, '').replace(/^"|"$/g, '');
        const longest = Math.max(0, ...text.split(/\\n|<br\s*\/?>/).map((piece) => piece.length));
        labels.set(id, Math.max(labels.get(id) ?? 0, longest || id.length));
        ids.push(id);
      }
    }
    for (let i = 1; i < ids.length; i++) edges.push([ids[i - 1], ids[i]]);
  }
  return { labels, edges };
}

/** Natural size of Mermaid's layered layout (16 px labels, 50 px node and rank spacing). */
function flowchartSize(code: string, horizontal: boolean): { width: number; height: number } | null {
  const { labels, edges } = parseFlowchart(code);
  if (!labels.size) return null;
  const rank = new Map<string, number>([...labels.keys()].map((node) => [node, 0]));
  for (let pass = 0; pass < labels.size; pass++) {
    let changed = false;
    for (const [from, to] of edges) {
      const next = (rank.get(from) ?? 0) + 1;
      if (next > (rank.get(to) ?? 0) && next < labels.size) {
        rank.set(to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const ranks = new Map<number, number[]>();
  for (const [node, value] of rank) {
    ranks.set(value, [...(ranks.get(value) ?? []), Math.min(220, 32 + (labels.get(node) ?? 4) * 7.5)]);
  }
  const nodeH = 54;
  const groups = [...ranks.values()];
  if (horizontal) {
    return {
      width: groups.reduce((sum, widths) => sum + Math.max(...widths), 0) + 50 * (groups.length - 1),
      height: Math.max(...groups.map((widths) => widths.length)) * (nodeH + 50) - 50,
    };
  }
  return {
    width: Math.max(...groups.map((widths) => widths.reduce((sum, w) => sum + w, 0) + 50 * (widths.length - 1))),
    height: groups.length * (nodeH + 50) - 50,
  };
}

function diagramSize(mermaid: string) {
  const head = mermaid.trim().split('\n')[0]?.trim().toLowerCase() || '';
  if (/^(flowchart|graph)\s+(lr|rl)\b/.test(head)) return flowchartSize(mermaid, true);
  if (/^(flowchart|graph)\s+(td|tb|bt)\b/.test(head)) return flowchartSize(mermaid, false);
  return null;
}

export function diagramAspect(mermaid: string): number | null {
  const head = mermaid.trim().split('\n')[0]?.trim().toLowerCase() || '';
  const size = diagramSize(mermaid);
  if (size) return size.width / size.height;
  if (/^(flowchart|graph)\s+(lr|rl)\b/.test(head)) return 3;
  if (/^(flowchart|graph)\s+(td|tb|bt)\b/.test(head)) return 1;
  if (/^(timeline|gantt|journey|gitgraph)/.test(head)) return 3;
  if (/^(sequencediagram|mindmap)/.test(head)) return 1.6;
  return null;
}

/** The layout the stage actually draws (it repairs mismatched type/layout pairs). */
function renderedLayout(slide: StudioSlide): string {
  const type = String(slide.type ?? '').toUpperCase();
  const layout = String(slide.layout ?? '').toUpperCase();
  if (type === 'DEFINITION' || layout === 'DEFINITION') return 'DEFINITION';
  if (type === 'FORMULA' || layout === 'FORMULA_FOCUS') return 'FORMULA_FOCUS';
  if (type === 'EXAMPLE' || layout === 'EXAMPLE_STEPS') return 'EXAMPLE_STEPS';
  if (type === 'COMPARISON' || layout === 'TWO_COLUMN' || slide.leftColumn || slide.rightColumn) {
    return slide.leftColumn || slide.rightColumn ? 'TWO_COLUMN' : 'BULLETS';
  }
  if (type === 'CHECKPOINT' || type === 'ACTIVITY' || layout === 'QUOTE_CALLOUT' || slide.callout) {
    return 'QUOTE_CALLOUT';
  }
  return layout || 'BULLETS';
}

/** Rows a monospace block needs when lines wrap at `columns` characters. */
function codeRows(text: string, columns: number) {
  return text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / columns)), 0);
}

function codeHeight(code: NonNullable<StudioSlide['code']>, width: number) {
  const columns = Math.max(16, Math.floor((width - CODE_GUTTER) / CODE_CHAR));
  let height = CODE_CHROME + codeRows(code.source, columns) * CODE_LINE;
  if (code.output) {
    const outputColumns = Math.max(16, Math.floor((width - 24) / (OUTPUT_FONT * 0.6)));
    height += OUTPUT_CHROME + codeRows(code.output, outputColumns) * OUTPUT_LINE;
  }
  return height;
}

/** Longest code line, in characters. */
export function longestCodeLine(slide: StudioSlide): number {
  return Math.max(0, ...String(slide.code?.source ?? '').split('\n').map((line) => line.length));
}

function textHeight(slide: StudioSlide, width: number) {
  const blocks: number[] = [];
  const layout = renderedLayout(slide);
  if (layout === 'DEFINITION' && plain(slide.callout?.text)) {
    blocks.push(32 + 20 + wrapLines(slide.callout!.text!, width - 34) * LINE);
  }
  if (slide.formula && (plain(slide.formula.latex) || plain(slide.formula.explanation))) {
    blocks.push(64 + wrapLines(String(slide.formula.explanation ?? ''), width - 32) * LINE);
  }
  if (slide.code?.source?.trim()) {
    blocks.push(codeHeight(slide.code, width));
  }
  const example = slide.example;
  if (example && (plain(example.problem) || example.steps?.length || plain(example.solution))) {
    const parts = [
      plain(example.problem) ? wrapLines(example.problem!, width) * TIGHT_LINE : 0,
      (example.steps ?? []).length
        ? (example.steps ?? []).reduce((sum, step) => sum + wrapLines(step, width - 20) * TIGHT_LINE, 0) +
          6 * ((example.steps ?? []).length - 1)
        : 0,
      plain(example.solution) ? 16 + wrapLines(example.solution!, width - 28) * TIGHT_LINE : 0,
    ].filter(Boolean);
    blocks.push(parts.reduce((sum, part) => sum + part, 0) + 12 * (parts.length - 1));
  }
  if (layout === 'TWO_COLUMN' && (slide.leftColumn || slide.rightColumn)) {
    const column = (width - 16) / 2 - 34;
    const height = (col: StudioSlide['leftColumn']) =>
      col
        ? 34 + (plain(col.heading) ? wrapLines(col.heading!, column) * TIGHT_LINE + 8 : 0) +
          bulletsHeight(col.bullets ?? [], column, TIGHT_LINE, 8)
        : 0;
    blocks.push(Math.max(height(slide.leftColumn), height(slide.rightColumn)));
  }
  if (layout === 'QUOTE_CALLOUT' && plain(slide.callout?.text)) {
    blocks.push(32 + 20 + wrapLines(slide.callout!.text!, width - 44) * LINE);
  }
  if (layout !== 'TWO_COLUMN' && slide.bullets?.length) {
    blocks.push(bulletsHeight(slide.bullets, width));
  }
  const table = slide.table;
  if (table?.headers?.length) {
    const cell = width / table.headers.length - 16;
    const rowHeight = (cells: unknown[]) =>
      12 + Math.max(1, ...cells.map((value) => wrapLines(typeof value === 'string' || typeof value === 'number' ? String(value) : '', cell, 12.8))) * 19;
    blocks.push(
      rowHeight(table.headers) + (table.rows ?? []).reduce((sum, row) => sum + rowHeight(row ?? []), 0),
    );
  }
  const used = blocks.filter((height) => height > 0);
  return used.reduce((sum, height) => sum + height, 0) + BLOCK_GAP * Math.max(0, used.length - 1);
}

function wordCount(slide: StudioSlide) {
  const texts = [
    ...(slide.bullets ?? []),
    ...(slide.leftColumn?.bullets ?? []),
    ...(slide.rightColumn?.bullets ?? []),
    slide.callout?.text,
    slide.formula?.explanation,
    slide.example?.problem,
    ...(slide.example?.steps ?? []),
    slide.example?.solution,
    ...(slide.table?.rows ?? []).flat(),
  ];
  return texts.reduce<number>((sum, text) => sum + plain(text).split(/\s+/).filter(Boolean).length, 0);
}

/** Null for title/section slides, which have no body to overflow. */
export function estimateSlideFit(slide: StudioSlide): SlideFit | null {
  const layout = String(slide.layout ?? '');
  if (layout === 'TITLE_CENTER' || layout === 'SECTION_DIVIDER' || slide.type === 'TITLE' || slide.type === 'SECTION') {
    return null;
  }
  const bodyHeight = STAGE_H - headerHeight(slide) - FOOTER_H - BODY_PAD_Y;
  const bodyWidth = STAGE_W - 2 * PAD_X;
  const image = (slide as { image?: { src?: string; position?: string; width?: number } }).image;
  const mermaid = String(slide.diagram?.mermaid ?? '').trim();
  const figure = image?.src
    ? { position: image.position ?? 'right', width: Number(image.width) || 46, aspect: null as number | null }
    : mermaid
      ? {
          position: (slide.diagram as { position?: string } | null)?.position ?? 'right',
          width: Number((slide.diagram as { width?: number } | null)?.width) || 48,
          aspect: diagramAspect(mermaid),
        }
      : null;

  let arrangement: SlideFit['arrangement'] = 'text';
  let width = bodyWidth;
  let room = bodyHeight;
  let figureBox = { width: 0, height: 0 };
  if (figure) {
    const probe = textHeight(slide, bodyWidth);
    if (!probe) {
      return { fill: 0, arrangement: 'fill', excessWords: 0, diagramLabelPx: labelPx(mermaid, bodyWidth, bodyHeight) };
    }
    const stacked =
      figure.position === 'center' || figure.position === 'full' || (figure.aspect ?? 0) > WIDE_ASPECT;
    if (stacked) {
      arrangement = 'stack';
      room = bodyHeight * 0.45 - 16;
      figureBox = { width: bodyWidth, height: bodyHeight * 0.55 };
    } else {
      arrangement = 'side';
      const share = Math.min(62, Math.max(40, figure.width)) / 100;
      width = (bodyWidth - FIGURE_GAP) * (1 - share);
      figureBox = { width: (bodyWidth - FIGURE_GAP) * share, height: bodyHeight };
    }
  }
  const height = textHeight(slide, width);
  const fill = room > 0 ? height / room : 2;
  const words = wordCount(slide);
  const excessWords = fill > 1 ? Math.ceil(words * (1 - 1 / fill)) : 0;
  return {
    fill: Math.round(fill * 100) / 100,
    arrangement,
    excessWords,
    diagramLabelPx: mermaid && !image?.src ? labelPx(mermaid, figureBox.width, figureBox.height) : null,
  };
}

/** Diagram title and card padding take ~56 px of the figure box. */
function labelPx(mermaid: string, boxWidth: number, boxHeight: number): number | null {
  const size = diagramSize(mermaid);
  if (!size || boxWidth <= 0) return null;
  const scale = Math.min(1, (boxWidth - 24) / size.width, (boxHeight - 56) / size.height);
  return Math.round(16 * scale * 10) / 10;
}
