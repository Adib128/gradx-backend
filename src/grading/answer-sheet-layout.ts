/**
 * Answer-sheet geometry — mirror of gradx-frontend/lib/answer-sheet-pdf.ts
 * (layout section). The printed PDF is generated client-side, so the graders
 * must recompute the exact same block positions. Keep both files in sync.
 */

export const STUDENT_ID_POSITIONS = [
  'TOP_LEFT',
  'TOP_RIGHT',
  'BOTTOM_LEFT',
  'BOTTOM_RIGHT',
] as const;

export type StudentIdPosition = (typeof STUDENT_ID_POSITIONS)[number];

export function normalizeStudentIdPosition(value: unknown): StudentIdPosition {
  const raw = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  if ((STUDENT_ID_POSITIONS as readonly string[]).includes(raw)) {
    return raw as StudentIdPosition;
  }
  return 'TOP_LEFT';
}

export type AnswerSheetPdfAnswerRow = {
  number: number;
  labels: string[];
};

export type AnswerSheetBlockKind = 'MCQ' | 'TRUE_FALSE';

export type AnswerSheetDrawBlock = {
  x: number;
  y: number;
  rows: number;
  /** Index into the organized `rows` array. */
  start: number;
  kind: AnswerSheetBlockKind;
};

export function isTrueFalseAnswerRow(row: AnswerSheetPdfAnswerRow): boolean {
  return (
    row.labels.length === 2 &&
    row.labels[0] === 'T' &&
    row.labels[1] === 'F'
  );
}

export function answerRowKind(row: AnswerSheetPdfAnswerRow): AnswerSheetBlockKind {
  return isTrueFalseAnswerRow(row) ? 'TRUE_FALSE' : 'MCQ';
}

/**
 * Contiguous type bands: all MCQ first, then all True/False.
 * Printed numbers become 1..n in that sheet order.
 */
export function organizeAnswerRowsByType(
  rows: AnswerSheetPdfAnswerRow[],
): AnswerSheetPdfAnswerRow[] {
  const mcq = rows.filter((row) => !isTrueFalseAnswerRow(row));
  const trueFalse = rows.filter((row) => isTrueFalseAnswerRow(row));
  return [...mcq, ...trueFalse].map((row, index) => ({
    ...row,
    number: index + 1,
  }));
}

export type AnswerSheetPdfConfig = {
  title: string;
  sideText?: string;
  numberOfStudentIdDigits: number;
  includeStudentInfoHeader: boolean;
  includeSection?: boolean;
  includeKeyVersionSection: boolean;
  studentIdPosition?: StudentIdPosition | string;
  selectedVersionLetter?: string;
  /** Preferred over letter when set — maps 1:1 to the machine marker. */
  selectedVersionNumber?: number;
};

type LayoutPlan = {
  idStartX: number;
  idStartY: number;
  idRight: number;
  idBottom: number;
  digitGap: number;
  digitBoxSize: number;
  digitStartX: number;
  rowGap: number;
  gridTopY: number;
  gridHeight: number;
  idBubbleRadius: number;
  idLabelFontSize: number;
  optionGap: number;
  bubbleRadius: number;
  rowPitch: number;
  headerPad: number;
  sideTextX: number;
  studentIdPosition: StudentIdPosition;
  /** Organized MCQ-then-TF rows used for drawing. */
  rows: AnswerSheetPdfAnswerRow[];
  /** Type-homogeneous answer blocks. */
  blocks: AnswerSheetDrawBlock[];
  /** @deprecated derived from blocks — kept for transitional callers */
  topY: number;
  bottomY: number;
  topColumns: number[];
  bottomColumns: number[];
  topRows: number;
  bottomRows: number;
};

type Rect = { x: number; y: number; w: number; h: number };

/** Keep answer bubbles left of right registration marks and vertical title. */
const CONTENT_RIGHT = 182;
/**
 * Clear of left registration marks / version strip (centre x≈10.25).
 * Student ID / answers start here.
 */
const CONTENT_LEFT = 36;
/**
 * Baseline of the vertical course/assessment title. Glyphs extend ~2mm left of
 * it, staying clear of the right registration marks.
 */
const SIDE_TEXT_X = 206.3;
const CONTENT_BOTTOM = 278;
/**
 * Below Name/Section capsule (~14–26) with clear gap before Student ID / answers.
 */
const CONTENT_TOP = 38;
const GAP = 4;

/** Student ID bubble rows — digit `0` is the first (top) row. */
export const STUDENT_ID_ROW_DIGITS = [
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
] as const;

/** Max questions per answer column (block 1: 1–10, block 2: 11–20, …). */
export const ANSWER_BLOCK_MAX_ROWS = 10;

/** Name / Section capsule (stadium bar). Section sits on the right with a divider. */
export const NAME_HEADER = {
  x: 24,
  y: 14,
  w: 162,
  h: 12,
  radius: 6,
  /** Width reserved on the right for the Section field. */
  sectionWidth: 44,
} as const;

/**
 * Preferred starting zoom from question count. Layout will try this first,
 * then zoom out only if content still cannot fit using same line + next line.
 */
export function contentZoom(questionCount: number): number {
  const n = Math.max(0, questionCount);
  if (n <= 8) return 1.5;
  if (n <= 15) return 1.35;
  if (n <= 25) return 1.22;
  if (n <= 40) return 1.1;
  if (n <= 55) return 0.95;
  if (n <= 75) return 0.82;
  if (n <= 100) return 0.7;
  return 0.58;
}

/** Zoom ladder: try larger (fill page) first, then zoom out until it fits. */
function zoomLadder(preferred: number): number[] {
  const steps = [
    1.55, 1.45, 1.35, 1.28, 1.22, 1.15, 1.1, 1.05, 1.0, 0.95, 0.9, 0.85, 0.8,
    0.76, 0.7, 0.64, 0.58, 0.52, 0.46,
  ];
  const start = steps.findIndex((z) => z <= preferred + 0.001);
  const from = start >= 0 ? start : 0;
  return steps.slice(from);
}

function columnWidth(optionGap: number, maxOptions = 5) {
  return 9 + maxOptions * optionGap;
}

function buildColumnXs(
  left: number,
  right: number,
  count: number,
  colWidth: number,
): number[] {
  if (count <= 0) return [];
  if (count === 1) return [left];
  const span = Math.max(colWidth, right - left);
  // Spread columns evenly across the full strip (ZipGrade-style).
  const step = span / count;
  return Array.from({ length: count }, (_, index) => left + index * step);
}

/**
 * Student ID block metrics — larger base size, scaled by content zoom.
 */
function resolveIdMetrics(questionCount: number, studentIdDigits: number) {
  const zoom = contentZoom(questionCount);
  // Intentionally larger than the old compact grid so the ID block reads clearly.
  const digitGap = Math.max(3.0, 4.2 * zoom);
  const rowGap = Math.max(3.4, 5.0 * zoom);
  const digitBoxSize = Math.max(2.6, 3.5 * zoom);
  const idBubbleRadius = Math.max(1.35, 1.75 * zoom);
  const idLabelFontSize = Math.max(5.2, 6.8 * zoom);
  const idBlockWidth = studentIdDigits * digitGap + 4.0;
  const gridHeight = 10 * rowGap + 3.0;
  // Label only (digit entry rectangles removed) → tighter top padding.
  const idBlockHeight = 4.2 * zoom + 1.2 + gridHeight + 2;

  return {
    digitGap,
    digitBoxSize,
    rowGap,
    gridHeight,
    idBubbleRadius,
    idLabelFontSize,
    idBlockWidth,
    idBlockHeight,
    scale: zoom,
    zoom,
  };
}

/** Place the ID block flush in the chosen corner of the content frame. */
function placeIdBlock(
  position: StudentIdPosition,
  metrics: ReturnType<typeof resolveIdMetrics>,
) {
  const isLeft = position === 'TOP_LEFT' || position === 'BOTTOM_LEFT';
  const isTop = position === 'TOP_LEFT' || position === 'TOP_RIGHT';

  const idStartX = isLeft
    ? CONTENT_LEFT
    : Math.max(CONTENT_LEFT, CONTENT_RIGHT - metrics.idBlockWidth);
  const idStartY = isTop
    ? CONTENT_TOP + 2
    : Math.max(CONTENT_TOP + 20, CONTENT_BOTTOM - metrics.idBlockHeight);

  const digitStartX = idStartX + 1.0;
  // No digit entry rectangles — start the bubble grid just under the label.
  const gridTopY = idStartY + 4.2 * metrics.scale + 1.0;
  const idRight = idStartX - 0.5 + metrics.idBlockWidth;
  const idBottom = gridTopY - 1.6 + metrics.gridHeight;

  return {
    idStartX,
    idStartY,
    digitStartX,
    gridTopY,
    idRight,
    idBottom,
    digitGap: metrics.digitGap,
    digitBoxSize: metrics.digitBoxSize,
    rowGap: metrics.rowGap,
    gridHeight: metrics.gridHeight,
    idBubbleRadius: metrics.idBubbleRadius,
    idLabelFontSize: metrics.idLabelFontSize,
    studentIdPosition: position,
  };
}

/**
 * Split the page into non-overlapping zones (ZipGrade-style):
 * 1) Student ID corner (reserved)
 * 2) Primary — full-height strip beside the ID (tall answer columns)
 * 3) Secondary — pocket under/above the ID (True/False or overflow)
 *
 * Answers never enter the ID rectangle. Version strip stays on the same
 * vertical line as the left registration marks (x≈10.25), outside CONTENT_LEFT.
 */
function answerZones(
  position: StudentIdPosition,
  id: ReturnType<typeof placeIdBlock>,
): { primary: Rect; secondary: Rect } {
  const isTop = position === 'TOP_LEFT' || position === 'TOP_RIGHT';
  const isLeft = position === 'TOP_LEFT' || position === 'BOTTOM_LEFT';

  const tallBeside: Rect = isLeft
    ? {
        x: id.idRight + GAP,
        y: CONTENT_TOP,
        w: Math.max(0, CONTENT_RIGHT - (id.idRight + GAP)),
        h: Math.max(0, CONTENT_BOTTOM - CONTENT_TOP),
      }
    : {
        x: CONTENT_LEFT,
        y: CONTENT_TOP,
        w: Math.max(0, id.idStartX - GAP - CONTENT_LEFT),
        h: Math.max(0, CONTENT_BOTTOM - CONTENT_TOP),
      };

  const idPocketW = isLeft
    ? Math.max(0, id.idRight - CONTENT_LEFT)
    : Math.max(0, CONTENT_RIGHT - id.idStartX);
  const idPocketX = isLeft ? CONTENT_LEFT : id.idStartX;

  const idPocket: Rect = isTop
    ? {
        x: idPocketX,
        y: id.idBottom + GAP,
        w: idPocketW,
        h: Math.max(0, CONTENT_BOTTOM - (id.idBottom + GAP)),
      }
    : {
        x: idPocketX,
        y: CONTENT_TOP,
        w: idPocketW,
        h: Math.max(0, id.idStartY - GAP - CONTENT_TOP),
      };

  return { primary: tallBeside, secondary: idPocket };
}

function packRect(
  rect: Rect,
  questionCount: number,
  preferMinCols: number,
  zoom: number,
  maxOptions = 5,
  allowPartial = false,
): {
  columns: number[];
  rows: number;
  optionGap: number;
  bubbleRadius: number;
  rowPitch: number;
  headerPad: number;
  capacity: number;
} | null {
  if (rect.w < 12 || rect.h < 14 || questionCount <= 0) return null;

  // Prefer large gaps / pitches first so tall zones stretch ZipGrade-style.
  const baseGaps = [6.2, 5.6, 5.0, 4.4, 3.8, 3.4, 3.0, 2.7];
  const basePitches = [11.0, 10.0, 9.0, 8.2, 7.4, 6.6, 5.8, 5.0, 4.4, 3.8, 3.4, 3.0, 2.7];
  const optionGaps = baseGaps
    .map((g) => Math.max(2.6, g * zoom))
    .filter((g, i, arr) => arr.indexOf(g) === i);
  const pitches = basePitches
    .map((p) => Math.max(2.6, p * zoom))
    .filter((p, i, arr) => arr.indexOf(p) === i);

  let best: {
    columns: number[];
    rows: number;
    optionGap: number;
    bubbleRadius: number;
    rowPitch: number;
    headerPad: number;
    capacity: number;
    score: number;
  } | null = null;

  for (const optionGap of optionGaps) {
    const bubbleRadius = Math.max(1.25, Math.min(2.5, optionGap * 0.4));
    const colW = columnWidth(optionGap, maxOptions);
    const maxCols = Math.max(0, Math.floor(rect.w / colW));
    if (maxCols <= 0) continue;
    // Prefer block-of-10 columns: skip gaps that cannot fit the needed
    // column count when the zone is tall enough for those blocks.
    if (
      preferMinCols > 1 &&
      maxCols < preferMinCols &&
      rect.h >= 60 &&
      !allowPartial
    ) {
      continue;
    }
    if (
      preferMinCols > 1 &&
      maxCols < preferMinCols &&
      rect.h >= 60 &&
      allowPartial
    ) {
      // Still prefer smaller gaps that unlock the target column count.
      // Soft-skip only when a later (narrower) gap could fit preferMinCols.
      const narrowerFits = optionGaps.some((g) => {
        if (g >= optionGap) return false;
        return Math.floor(rect.w / columnWidth(g, maxOptions)) >= preferMinCols;
      });
      if (narrowerFits) continue;
    }

    for (let cols = maxCols; cols >= 1; cols -= 1) {
      for (const rowPitch of pitches) {
        const headerPad = Math.max(2.2, rowPitch * 0.42);
        const rows = Math.max(0, Math.floor((rect.h - headerPad) / rowPitch));
        if (rows <= 0) continue;

        const capacity = cols * rows;
        if (capacity < questionCount && !allowPartial) continue;
        if (capacity <= 0) continue;

        const placeable = Math.min(questionCount, capacity);
        const rowsUsed = Math.ceil(placeable / cols);
        const usedHeight = headerPad + rowsUsed * rowPitch;
        const fill = Math.min(1, usedHeight / Math.max(1, rect.h));
        const blockAligned =
          rowsUsed <= ANSWER_BLOCK_MAX_ROWS
            ? 1
            : Math.max(0, 1 - (rowsUsed - ANSWER_BLOCK_MAX_ROWS) / 10);

        const score =
          placeable * 40 +
          optionGap * 16 +
          rowPitch * 20 +
          bubbleRadius * 8 +
          fill * 70 +
          blockAligned * 25 +
          // Strongly prefer the block-of-10 column count.
          (cols === preferMinCols ? 90 : 0) -
          Math.abs(cols - preferMinCols) * 35 -
          (cols - 1) * 2;

        if (!best || score > best.score) {
          best = {
            columns: buildColumnXs(rect.x, rect.x + rect.w, cols, colW),
            rows,
            optionGap,
            bubbleRadius,
            rowPitch,
            headerPad,
            capacity,
            score,
          };
        }
      }
    }
  }

  if (!best) return null;
  const { score: _score, ...pack } = best;
  return pack;
}

function preferColsForCount(n: number, kind: AnswerSheetBlockKind): number {
  // Prefer a single tall column so the next type can sit on the same row.
  if (kind === 'TRUE_FALSE') return n <= 10 ? 1 : n <= 20 ? 2 : 3;
  // Columns hold at most 10 questions (block 1: 1–10, block 2: 11–20, …).
  return Math.max(1, Math.ceil(n / ANSWER_BLOCK_MAX_ROWS));
}

function maxOptionsForKind(
  kind: AnswerSheetBlockKind,
  sampleRows: AnswerSheetPdfAnswerRow[] = [],
): number {
  if (kind === 'TRUE_FALSE') return 2;
  const fromRows = sampleRows.reduce(
    (max, row) => Math.max(max, row.labels.length),
    0,
  );
  if (fromRows > 0) return Math.max(2, Math.min(5, fromRows));
  return 4;
}

/**
 * Stretch row pitch / bubbles so packed columns use the full zone height
 * (ZipGrade-style page fill) instead of clustering at the top.
 */
function stretchMetricsToZone(
  blocks: AnswerSheetDrawBlock[],
  zone: Rect,
  metrics: {
    optionGap: number;
    bubbleRadius: number;
    rowPitch: number;
    headerPad: number;
  },
): {
  optionGap: number;
  bubbleRadius: number;
  rowPitch: number;
  headerPad: number;
} {
  if (blocks.length === 0 || zone.h < 20) return metrics;

  // Only stretch a single horizontal band — multi-band layouts must keep
  // packed pitch so lower rows do not overflow the page.
  const minY = Math.min(...blocks.map((block) => block.y));
  const firstBand = blocks.filter((block) => Math.abs(block.y - minY) < 3);
  const hasSecondBand = blocks.some((block) => block.y > minY + 3);
  if (hasSecondBand || firstBand.length === 0) return metrics;

  const maxRows = Math.max(...firstBand.map((block) => block.rows));
  if (maxRows <= 0) return metrics;

  const available = Math.max(20, zone.h - 8);
  const headerPad = Math.max(2.6, Math.min(5.8, metrics.headerPad));
  const idealPitch = (available - headerPad) / maxRows;
  // Allow generous ZipGrade-style vertical spacing so blocks fill the page.
  const rowPitch = Math.max(
    metrics.rowPitch,
    Math.min(20.0, idealPitch),
  );
  const bubbleRadius = Math.max(
    metrics.bubbleRadius,
    Math.min(2.85, rowPitch * 0.22),
  );

  return {
    // Keep packed horizontal gap so columns do not collide after stretch.
    optionGap: metrics.optionGap,
    bubbleRadius,
    rowPitch,
    headerPad: Math.max(headerPad, Math.min(rowPitch * 0.32, 6.5)),
  };
}

/**
 * After packing columns into the front free rect, leave leftover space in this
 * order so the next type band stays on the same line when possible:
 *   1) remaining width to the right of used columns (same row)
 *   2) remaining height under the used columns
 *   3) any following free rects
 */
function consumePackSpace(
  free: Rect[],
  pack: {
    columns: number[];
    optionGap: number;
    headerPad: number;
    rowPitch: number;
  },
  maxOptions: number,
  placedCount: number,
): Rect[] {
  if (free.length === 0 || placedCount <= 0 || pack.columns.length === 0) {
    return free;
  }

  const [head, ...rest] = free;
  const colW = columnWidth(pack.optionGap, maxOptions);
  const colsUsed = pack.columns.length;
  const firstColX = pack.columns[0];
  const lastColX = pack.columns[colsUsed - 1];
  const usedLeft = Math.min(firstColX, head.x);
  const usedRight = lastColX + colW;
  const rowsUsed = Math.ceil(placedCount / colsUsed);
  const usedHeight = pack.headerPad + rowsUsed * pack.rowPitch + GAP + 2;

  const next: Rect[] = [];

  // Same-line remnant to the right of this type’s columns.
  const rightW = head.x + head.w - usedRight - GAP;
  if (rightW >= 14) {
    next.push({
      x: usedRight + GAP,
      y: head.y,
      w: rightW,
      h: head.h,
    });
  }

  // Space under the used columns (only if tall enough for another band).
  const belowH = head.h - usedHeight;
  if (belowH >= 18) {
    next.push({
      x: usedLeft,
      y: head.y + usedHeight,
      w: Math.max(12, Math.min(head.w, usedRight - usedLeft + GAP)),
      h: belowH,
    });
  }

  return [...next, ...rest];
}

/**
 * Pack one type band into free rectangles:
 * 1) fill the current line (as many as fit)
 * 2) overflow onto the next line / remaining zones
 * Does not zoom — caller retries at a smaller zoom if anything remains.
 */
function packTypeBand(
  free: Rect[],
  count: number,
  startIndex: number,
  kind: AnswerSheetBlockKind,
  zoom: number,
  sampleRows: AnswerSheetPdfAnswerRow[] = [],
): {
  blocks: AnswerSheetDrawBlock[];
  free: Rect[];
  remaining: number;
  metrics: {
    optionGap: number;
    bubbleRadius: number;
    rowPitch: number;
    headerPad: number;
  } | null;
} {
  if (count <= 0) {
    return {
      blocks: [],
      free,
      remaining: 0,
      metrics: null,
    };
  }

  const blocks: AnswerSheetDrawBlock[] = [];
  let remaining = count;
  let cursor = startIndex;
  let working = [...free];
  let metrics: {
    optionGap: number;
    bubbleRadius: number;
    rowPitch: number;
    headerPad: number;
  } | null = null;
  const maxOptions = maxOptionsForKind(kind, sampleRows);

  while (remaining > 0 && working.length > 0) {
    const rect = working[0];
    // allowPartial: fill this line/zone, spill leftover to the next line.
    const pack = packRect(
      rect,
      remaining,
      preferColsForCount(remaining, kind),
      zoom,
      maxOptions,
      true,
    );

    if (!pack || pack.columns.length === 0 || pack.capacity <= 0) {
      working.shift();
      continue;
    }

    const placeable = Math.min(remaining, pack.capacity);
    const maxRows = Math.min(pack.rows, ANSWER_BLOCK_MAX_ROWS);
    const neededCols = Math.min(
      pack.columns.length,
      Math.max(1, Math.ceil(placeable / Math.max(1, maxRows))),
    );
    const cols = pack.columns.slice(0, neededCols);

    metrics = {
      optionGap: pack.optionGap,
      bubbleRadius: pack.bubbleRadius,
      rowPitch: pack.rowPitch,
      headerPad: pack.headerPad,
    };

    // Fill each column up to the block size (10) before starting the next
    // so blocks read as 1–10, 11–20, 21–30, …
    let left = placeable;
    let placedInBand = 0;

    cols.forEach((x) => {
      const rows = Math.min(maxRows, left);
      if (rows <= 0) return;
      blocks.push({
        x,
        y: rect.y + 2,
        rows,
        start: cursor,
        kind,
      });
      cursor += rows;
      left -= rows;
      placedInBand += rows;
    });

    remaining -= placedInBand;
    working = consumePackSpace(
      [{ ...rect }, ...working.slice(1)],
      { ...pack, columns: cols },
      maxOptions,
      placedInBand,
    );
  }

  return { blocks, free: working, remaining, metrics };
}

type LayoutAttempt = {
  id: ReturnType<typeof placeIdBlock>;
  blocks: AnswerSheetDrawBlock[];
  packMetrics: {
    optionGap: number;
    bubbleRadius: number;
    rowPitch: number;
    headerPad: number;
  };
  zones: { primary: Rect; secondary: Rect };
  placed: number;
  zoom: number;
};

/**
 * ZipGrade grid frame. Wider than CONTENT_LEFT/RIGHT: question numbers sit in
 * the cell's own number column, and bubbles still end before the right marks.
 */
const GRID_LEFT = 22;
const GRID_RIGHT = 190;
const GRID_TOP = 30;
const GRID_BOTTOM = 278;
const GRID_COL_GUTTER = 4;
const GRID_BAND_GUTTER = 3;
/** Width of the question-number column at the left of every cell. */
const NUMBER_COL_W = 5.5;
/** Option A centre sits this far right of the number column (drawAnswerBlock). */
const ANSWER_BUBBLE_OFFSET = 7;
const GRID_MAX_ROW_PITCH = 10;
const GRID_MAX_OPTION_GAP = 8;
const GRID_MAX_BUBBLE_RADIUS = 2.8;
const GRID_MIN_ROW_PITCH = 3.4;
const GRID_MIN_OPTION_GAP = 3.6;
/** Below this, the Student ID spans two cells (ZipGrade 100-question sheet). */
const GRID_MIN_DIGIT_GAP = 4.2;

type AnswerChunk = {
  start: number;
  rows: number;
  kind: AnswerSheetBlockKind;
};

/** Split organized rows into ZipGrade blocks of at most 10 (type-homogeneous). */
function chunkAnswerRows(rows: AnswerSheetPdfAnswerRow[]): AnswerChunk[] {
  const chunks: AnswerChunk[] = [];
  let index = 0;
  while (index < rows.length) {
    const kind = answerRowKind(rows[index]);
    let end = index + 1;
    while (
      end < rows.length &&
      end - index < ANSWER_BLOCK_MAX_ROWS &&
      answerRowKind(rows[end]) === kind
    ) {
      end += 1;
    }
    chunks.push({ start: index, rows: end - index, kind });
    index = end;
  }
  return chunks;
}

type ZipGradeGridPlan = {
  cols: number;
  bands: number;
  /** Cells (columns) the Student ID spans in its band. */
  idSpan: number;
  colW: number;
  bandH: number;
  bandGutter: number;
  rowPitch: number;
  optionGap: number;
  bubbleRadius: number;
  headerPad: number;
  digitGap: number;
};

function gridHeaderPad(bubbleRadius: number) {
  // Room for the "Student ID" label above the first row in band 0.
  return Math.max(5.5, bubbleRadius + 4);
}

/**
 * Pick the ZipGrade grid (columns × bands of 10-row cells) that gives the
 * largest bubbles. The Student ID occupies `idSpan` cells of one band; every
 * other cell holds one block of ≤10 questions. Ties prefer fewer empty cells,
 * then fewer bands (wider, shorter grid).
 */
function planZipGradeGrid(
  blockCount: number,
  digits: number,
  maxOptions: number,
): ZipGradeGridPlan | null {
  const gridW = GRID_RIGHT - GRID_LEFT;
  const gridH = GRID_BOTTOM - GRID_TOP;
  let best: (ZipGradeGridPlan & { empty: number }) | null = null;

  for (let cols = 2; cols <= 5; cols += 1) {
    const colW = (gridW - GRID_COL_GUTTER * (cols - 1)) / cols;
    const bubbleSpanW = colW - NUMBER_COL_W - ANSWER_BUBBLE_OFFSET - 2.5;
    const optionGap = Math.min(
      GRID_MAX_OPTION_GAP,
      bubbleSpanW / Math.max(1, maxOptions - 1),
    );
    if (optionGap < GRID_MIN_OPTION_GAP) continue;

    let idSpan = 0;
    let digitGap = 0;
    for (let span = 1; span <= Math.min(2, cols); span += 1) {
      const spanW = span * colW + (span - 1) * GRID_COL_GUTTER;
      const gap = (spanW - NUMBER_COL_W - 3) / Math.max(1, digits);
      if (gap >= GRID_MIN_DIGIT_GAP) {
        idSpan = span;
        digitGap = gap;
        break;
      }
    }
    if (idSpan === 0) continue;

    for (let bands = 1; bands <= 6; bands += 1) {
      const empty = cols * bands - idSpan - blockCount;
      if (empty < 0) continue;

      const perBand = (gridH - GRID_BAND_GUTTER * (bands - 1)) / bands;
      // bandH = headerPad + 9 pitches + bottom margin (≈ radius + 1).
      let rowPitch = Math.min(GRID_MAX_ROW_PITCH, (perBand - 6.5) / 9.4);
      if (rowPitch < GRID_MIN_ROW_PITCH) continue;
      let bubbleRadius = Math.min(
        GRID_MAX_BUBBLE_RADIUS,
        0.4 * Math.min(rowPitch, optionGap),
      );
      let headerPad = gridHeaderPad(bubbleRadius);
      // Re-fit pitch now that the header height is known.
      rowPitch = Math.min(
        rowPitch,
        (perBand - headerPad - bubbleRadius - 1.2) / 9,
      );
      if (rowPitch < GRID_MIN_ROW_PITCH) continue;
      bubbleRadius = Math.min(bubbleRadius, 0.4 * rowPitch);
      headerPad = gridHeaderPad(bubbleRadius);
      const bandH = headerPad + 9 * rowPitch + bubbleRadius + 1.2;

      const candidate = {
        cols,
        bands,
        idSpan,
        colW,
        bandH,
        bandGutter: GRID_BAND_GUTTER,
        rowPitch,
        optionGap,
        bubbleRadius,
        headerPad,
        digitGap: Math.min(digitGap, 6, Math.max(GRID_MIN_DIGIT_GAP, rowPitch)),
        empty,
      };
      if (!best) {
        best = candidate;
        continue;
      }
      const radiusDelta = candidate.bubbleRadius - best.bubbleRadius;
      if (radiusDelta > 0.05) {
        best = candidate;
      } else if (Math.abs(radiusDelta) <= 0.05) {
        if (
          candidate.empty < best.empty ||
          (candidate.empty === best.empty && candidate.bands < best.bands)
        ) {
          best = candidate;
        }
      }
      // More bands only shrink bubbles for this column count.
      break;
    }
  }

  if (!best) return null;

  // Spread bands down the page when bubbles hit their max size.
  const used = best.bands * best.bandH + GRID_BAND_GUTTER * (best.bands - 1);
  const leftover = GRID_BOTTOM - GRID_TOP - used;
  if (best.bands > 1 && leftover > 0) {
    best.bandGutter = GRID_BAND_GUTTER + Math.min(12, leftover / (best.bands - 1));
  }
  const { empty: _empty, ...plan } = best;
  return plan;
}

/**
 * ZipGrade grid: uniform cells of 10 rows, filled in reading order. The
 * Student ID takes the corner cell(s) and its rows align with the answer rows.
 *
 *   40 questions (36 MCQ + 4 T/F):
 *   [ Student ID ][ 1–10  ][ 11–20 ]
 *   [ 21–30      ][ 31–36 ][ 37–40 ]
 *
 * Name/section, version strip, and side title stay outside this grid.
 */
function tryZipGradeLayout(
  rows: AnswerSheetPdfAnswerRow[],
  digits: number,
  position: StudentIdPosition,
  zoom: number,
): LayoutAttempt {
  const chunks = chunkAnswerRows(rows);
  const maxOptions = Math.max(
    2,
    ...rows.map((row) => row.labels.length),
  );
  const plan = planZipGradeGrid(Math.max(1, chunks.length), digits, maxOptions);
  if (!plan) {
    return tryPackingLayout(rows, digits, position, zoom);
  }

  const {
    cols,
    bands,
    idSpan,
    colW,
    bandH,
    bandGutter,
    rowPitch,
    optionGap,
    bubbleRadius,
    headerPad,
    digitGap,
  } = plan;
  const cellX = (col: number) => GRID_LEFT + col * (colW + GRID_COL_GUTTER);
  const bandY = (band: number) => GRID_TOP + band * (bandH + bandGutter);

  const isLeft = position === 'TOP_LEFT' || position === 'BOTTOM_LEFT';
  const isTop = position === 'TOP_LEFT' || position === 'TOP_RIGHT';
  const idBand = isTop ? 0 : bands - 1;
  const idFirstCol = isLeft ? 0 : cols - idSpan;
  const isIdCell = (col: number, band: number) =>
    band === idBand && col >= idFirstCol && col < idFirstCol + idSpan;

  // Student ID rows share the band's row pitch so they line up with answers.
  const idBubbleRadius = Math.min(bubbleRadius, digitGap * 0.42, rowPitch * 0.4);
  const idStartX = cellX(idFirstCol) + NUMBER_COL_W;
  const gridTopY = bandY(idBand) + headerPad;
  const idGridHeight = 9 * rowPitch + 2 * (idBubbleRadius + 1.2);
  const idGridWidth = digits * digitGap + 3.2;
  const id: ReturnType<typeof placeIdBlock> = {
    idStartX,
    idStartY: gridTopY - idBubbleRadius - 0.6,
    digitStartX: idStartX + 1.0,
    gridTopY,
    idRight: idStartX - 0.5 + idGridWidth,
    idBottom: gridTopY - idBubbleRadius - 1.2 + idGridHeight,
    digitGap,
    digitBoxSize: digitGap * 0.75,
    rowGap: rowPitch,
    gridHeight: idGridHeight,
    idBubbleRadius,
    idLabelFontSize: Math.max(6, Math.min(8, headerPad + 1.2)),
    studentIdPosition: position,
  };

  // Reading-order fill (left → right, then next band), skipping the ID
  // cell(s), so 1–10 sits right beside the Student ID.
  const cells: { col: number; band: number }[] = [];
  for (let band = 0; band < bands; band += 1) {
    for (let col = 0; col < cols; col += 1) {
      if (!isIdCell(col, band)) cells.push({ col, band });
    }
  }

  const blocks: AnswerSheetDrawBlock[] = [];
  chunks.forEach((chunk, index) => {
    const cell = cells[index];
    if (!cell) return;
    blocks.push({
      x: cellX(cell.col) + NUMBER_COL_W,
      y: bandY(cell.band),
      rows: chunk.rows,
      start: chunk.start,
      kind: chunk.kind,
    });
  });

  const placed = blocks.reduce((sum, block) => sum + block.rows, 0);
  const gridRect: Rect = {
    x: GRID_LEFT,
    y: GRID_TOP,
    w: GRID_RIGHT - GRID_LEFT,
    h: GRID_BOTTOM - GRID_TOP,
  };

  return {
    id,
    blocks,
    packMetrics: { optionGap, bubbleRadius, rowPitch, headerPad },
    zones: { primary: gridRect, secondary: gridRect },
    placed,
    zoom,
  };
}

function tryLayoutAtZoom(
  rows: AnswerSheetPdfAnswerRow[],
  digits: number,
  position: StudentIdPosition,
  zoom: number,
): LayoutAttempt {
  const zip = tryZipGradeLayout(rows, digits, position, zoom);
  if (zip.placed >= rows.length) return zip;

  // Fallback: older free-rect packer if ZipGrade grid cannot place everything.
  return tryPackingLayout(rows, digits, position, zoom);
}

function tryPackingLayout(
  rows: AnswerSheetPdfAnswerRow[],
  digits: number,
  position: StudentIdPosition,
  zoom: number,
): LayoutAttempt {
  const n = rows.length;
  const metrics = resolveIdMetrics(n, digits);
  const scaledMetrics = {
    ...metrics,
    digitGap: Math.max(3.0, 4.2 * zoom),
    rowGap: Math.max(3.4, 5.0 * zoom),
    digitBoxSize: Math.max(2.6, 3.5 * zoom),
    idBubbleRadius: Math.max(1.35, 1.75 * zoom),
    idLabelFontSize: Math.max(5.2, 6.8 * zoom),
    scale: zoom,
    zoom,
  };
  scaledMetrics.idBlockWidth = digits * scaledMetrics.digitGap + 4.0;
  scaledMetrics.gridHeight = 10 * scaledMetrics.rowGap + 3.0;
  scaledMetrics.idBlockHeight =
    8 * zoom + 2.2 + scaledMetrics.gridHeight + 2;

  const id = placeIdBlock(position, scaledMetrics);
  const zones = answerZones(position, id);
  const mcqRows = rows.filter((row) => !isTrueFalseAnswerRow(row));
  const tfRows = rows.filter((row) => isTrueFalseAnswerRow(row));

  const mcqBand = packTypeBand(
    [zones.primary].filter((rect) => rect.w >= 12 && rect.h >= 14),
    mcqRows.length,
    0,
    'MCQ',
    zoom,
    mcqRows,
  );
  const tfBand = packTypeBand(
    [zones.secondary, ...mcqBand.free].filter(
      (rect) => rect.w >= 12 && rect.h >= 14,
    ),
    tfRows.length,
    mcqRows.length,
    'TRUE_FALSE',
    zoom,
    tfRows,
  );

  const blocks = [...mcqBand.blocks, ...tfBand.blocks];
  const placed = blocks.reduce((sum, block) => sum + block.rows, 0);
  const baseMetrics = mcqBand.metrics ??
    tfBand.metrics ?? {
      optionGap: Math.max(2.8, 4.2 * zoom),
      bubbleRadius: Math.max(1.25, 1.6 * zoom),
      rowPitch: Math.max(3.0, 5.5 * zoom),
      headerPad: Math.max(3.6, 4.0 * zoom),
    };

  return {
    id,
    blocks,
    packMetrics: stretchMetricsToZone(mcqBand.blocks, zones.primary, baseMetrics),
    zones,
    placed,
    zoom,
  };
}

/**
 * ZipGrade-style single-page layout:
 * blocks of 10 stacked in columns with gutters, Student ID top-left,
 * True/False in the under-ID pocket when possible.
 */
export function computeAnswerSheetLayout(
  questionCount: number,
  studentIdDigits: number,
  studentIdPosition: StudentIdPosition | string = 'TOP_LEFT',
  answerRows: AnswerSheetPdfAnswerRow[] = [],
): LayoutPlan {
  const digits = Math.max(1, Math.min(16, studentIdDigits));
  const position = normalizeStudentIdPosition(studentIdPosition);

  const sourceRows =
    answerRows.length > 0
      ? answerRows
      : Array.from({ length: Math.max(0, questionCount) }, (_, index) => ({
          number: index + 1,
          labels: ['A', 'B', 'C', 'D'] as string[],
        }));

  const rows = organizeAnswerRowsByType(sourceRows);
  const n = rows.length;
  const preferredZoom = contentZoom(n);

  let chosen: LayoutAttempt | null = null;
  for (const zoom of zoomLadder(preferredZoom)) {
    const attempt = tryLayoutAtZoom(rows, digits, position, zoom);
    if (attempt.placed >= n) {
      chosen = attempt;
      break;
    }
    // Keep densest partial as last resort if nothing fully fits.
    if (!chosen || attempt.placed > chosen.placed) {
      chosen = attempt;
    }
  }

  if (!chosen) {
    const fallback = tryLayoutAtZoom(rows, digits, position, 0.5);
    chosen = fallback;
  }

  const mcqBlocks = chosen.blocks.filter((block) => block.kind === 'MCQ');
  const tfBlocks = chosen.blocks.filter((block) => block.kind === 'TRUE_FALSE');

  return {
    ...chosen.id,
    optionGap: chosen.packMetrics.optionGap,
    bubbleRadius: chosen.packMetrics.bubbleRadius,
    rowPitch: chosen.packMetrics.rowPitch,
    headerPad: chosen.packMetrics.headerPad,
    sideTextX: SIDE_TEXT_X,
    studentIdPosition: position,
    rows,
    blocks: chosen.blocks,
    topY: mcqBlocks[0]?.y ?? chosen.zones.primary.y,
    bottomY: tfBlocks[0]?.y ?? chosen.zones.secondary.y,
    topColumns: mcqBlocks.map((block) => block.x),
    bottomColumns: tfBlocks.map((block) => block.x),
    topRows: mcqBlocks[0]?.rows ?? 0,
    bottomRows: tfBlocks[0]?.rows ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Grading helpers (backend only)
// ---------------------------------------------------------------------------

const PAGE_W_MM = 210;
const PAGE_H_MM = 297;

type SheetQuestionLike = {
  type?: string | null;
  questionOptions?: unknown[] | null;
};

export function isTrueFalseQuestion(question: SheetQuestionLike): boolean {
  const type = String(question?.type || '').toUpperCase();
  return type.includes('TRUE') || type.includes('FALSE');
}

/**
 * Printed order of a version's questions: all MCQ first, then True/False
 * (stable within each band). Printed number N is index N-1 of this list.
 */
export function orderQuestionsForSheet<T extends SheetQuestionLike>(questions: T[]): T[] {
  return [
    ...questions.filter((question) => !isTrueFalseQuestion(question)),
    ...questions.filter((question) => isTrueFalseQuestion(question)),
  ];
}

/** Same labels the frontend prints (lib/assessment-version-questions.ts). */
export function buildAnswerRowsForQuestions(
  questions: SheetQuestionLike[],
): AnswerSheetPdfAnswerRow[] {
  return orderQuestionsForSheet(questions).map((question, index) => {
    const optionCount = Array.isArray(question.questionOptions)
      ? question.questionOptions.length
      : 0;
    const labels = isTrueFalseQuestion(question)
      ? ['T', 'F']
      : optionCount > 0
        ? Array.from({ length: Math.min(6, optionCount) }, (_, i) =>
            String.fromCharCode(65 + i),
          )
        : ['A', 'B', 'C', 'D', 'E'];
    return { number: index + 1, labels };
  });
}

/** Student ID digit counts the downloads offer; anything else prints 9. */
export function resolvePrintedIdDigits(value: unknown): number {
  const digits = Number(value);
  return [6, 9, 10].includes(digits) ? digits : 9;
}

export type GraderAnswerColumn = {
  startQuestion: number;
  count: number;
  /** Normalised x of option 1's centre. */
  bubbleAX: number;
  /** Normalised y of the first row's centre. */
  rowYStart: number;
  bubbleXStep: number;
  rowYStep: number;
  options: string[];
  rowLabels: string[][];
};

/**
 * Grader config (full-page normalised coordinates) for a printed sheet.
 * Sampling radii stay inside the printed outline so ring + in-bubble letter
 * do not read as a mark.
 */
export function buildGraderSheetConfig(layout: LayoutPlan, digits: number) {
  const nx = (mm: number) => mm / PAGE_W_MM;
  const ny = (mm: number) => mm / PAGE_H_MM;

  const columns: GraderAnswerColumn[] = layout.blocks.map((block) => {
    const rows = layout.rows.slice(block.start, block.start + block.rows);
    const optionGap =
      block.kind === 'TRUE_FALSE'
        ? Math.max(layout.optionGap, 5.2)
        : layout.optionGap;
    const options = rows.reduce<string[]>(
      (longest, row) => (row.labels.length > longest.length ? row.labels : longest),
      [],
    );
    return {
      startQuestion: block.start + 1,
      count: rows.length,
      bubbleAX: nx(block.x + 7),
      rowYStart: ny(block.y + layout.headerPad),
      bubbleXStep: nx(optionGap),
      rowYStep: ny(layout.rowPitch),
      options,
      rowLabels: rows.map((row) => row.labels),
    };
  });

  const idGridWidth = digits * layout.digitGap + 3.2;
  const idFrameTop = layout.gridTopY - layout.idBubbleRadius - 1.2;

  return {
    layoutVersion: 'zipgrade-grid-v1',
    numIdDigits: digits,
    answerGrid: {
      columns,
      bubbleRadius: nx(layout.bubbleRadius * 0.72),
      fillThreshold: 0.3,
      darknessDifferential: 1.3,
    },
    studentIdGrid: {
      digitStartX: nx(layout.digitStartX + layout.digitBoxSize / 2),
      gridTopY: ny(layout.gridTopY),
      digitGap: nx(layout.digitGap),
      rowGap: ny(layout.rowGap),
      bubbleRadius: nx(layout.idBubbleRadius * 0.72),
      rowDigits: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'],
      fillThreshold: 0.15,
      exact: true,
      roi: {
        x0: nx(layout.idStartX - 1.5),
        y0: ny(idFrameTop - 0.5),
        x1: nx(layout.idStartX - 0.5 + idGridWidth + 1),
        y1: ny(idFrameTop + layout.gridHeight + 0.5),
      },
    },
  };
}

export type GraderSheetConfig = ReturnType<typeof buildGraderSheetConfig>;

export function buildGraderSheetConfigForQuestions(options: {
  questions: SheetQuestionLike[];
  numberOfStudentIdDigits: unknown;
  studentIdPosition: unknown;
}): GraderSheetConfig | null {
  if (options.questions.length === 0) return null;
  const rows = buildAnswerRowsForQuestions(options.questions);
  const digits = resolvePrintedIdDigits(options.numberOfStudentIdDigits);
  const layout = computeAnswerSheetLayout(
    rows.length,
    digits,
    normalizeStudentIdPosition(options.studentIdPosition),
    rows,
  );
  return buildGraderSheetConfig(layout, digits);
}
