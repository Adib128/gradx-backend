/**
 * GradX answer-sheet layout configuration.
 *
 * ALL coordinates are normalised [0..1] relative to the FULL A4 page
 * (210 × 297 mm).  This matches both:
 *   - The Node grader: resizes the uploaded image to 1000 × 1414 (A4 ratio)
 *     and samples directly with these coordinates.
 *   - The Python/OpenCV grader: warps using detected registration marks and
 *     maps their expected page positions to a 1000 × 1414 canvas.
 *
 * Source: jsPDF answer-sheet generator (downloads/page.tsx)
 *   Page: 210 × 297 mm
 *   Registration marks (top-left corner of 4.5 × 4.5 mm squares):
 *     TL (18, 12)  TR (187, 12)  BL (18, 216)  BR (187, 216)
 *   Answer blocks:
 *     Top row  y = 55:  columns at x ∈ {88, 144}        (Q  1-10, Q 11-20)
 *     Bot row  y = 135: columns at x ∈ {32, 88, 144}    (Q 21-30, Q 31-40, Q 41-50)
 *   Bubble layout per block:
 *     First bubble A: blockX + 7 mm
 *     Bubble pitch:   5.5 mm
 *     First row y:    blockY + 6.5 mm
 *     Row pitch:      7.5 mm
 *     Bubble radius:  2.2 mm
 */

// Warp output dimensions (pixels) — A4 aspect ratio (297/210 ≈ 1.414)
export const WARP_WIDTH  = 1000;
export const WARP_HEIGHT = 1414;

/** Normalise x (mm) to [0..1] on an A4 page width of 210 mm. */
const nx = (xMm: number) => xMm / 210;
/** Normalise y (mm) to [0..1] on an A4 page height of 297 mm. */
const ny = (yMm: number) => yMm / 297;

/** Per-column answer block configuration (full-page normalised coordinates). */
interface ColumnConfig {
  startQuestion: number;
  count: number;
  /** Normalised x of the first bubble (option A) centre in each row. */
  bubbleAX: number;
  /** Normalised y of the first row centre. */
  rowYStart: number;
}

/** Build a ColumnConfig from raw jsPDF mm coordinates. */
const makeColumn = (
  blockX: number,
  blockY: number,
  startQ: number,
): ColumnConfig => ({
  startQuestion: startQ,
  count: 10,
  bubbleAX:   nx(blockX + 7),       // circle centre x of option A
  rowYStart:  ny(blockY + 6.5),     // circle centre y of first row
});

export const SHEET_CONFIG = {
  /**
   * Expected centres of the four corner registration marks,
   * in full-page normalised coordinates.
   * Mark top-left (18, 12) + half-size (2.25) → centre = (20.25, 14.25)
   */
  inputAnchors: {
    topLeft:     { x: nx(20.25), y: ny(14.25)  },   // ≈ (0.0964, 0.0480)
    topRight:    { x: nx(189.25), y: ny(14.25)  },  // ≈ (0.9012, 0.0480)
    bottomLeft:  { x: nx(20.25), y: ny(218.25) },   // ≈ (0.0964, 0.7349)
    bottomRight: { x: nx(189.25), y: ny(218.25) },  // ≈ (0.9012, 0.7349)
  },

  /**
   * Search window half-width (fraction of image dimension) around each
   * expected anchor position when scanning for the registration mark.
   */
  anchorSearchHalf: 0.12,

  answerGrid: {
    columns: [
      makeColumn(88,  55,  1),   // Q  1-10  (top-left answer block)
      makeColumn(144, 55,  11),  // Q 11-20  (top-right answer block)
      makeColumn(32,  135, 21),  // Q 21-30  (bottom-left answer block)
      makeColumn(88,  135, 31),  // Q 31-40  (bottom-middle answer block)
      makeColumn(144, 135, 41),  // Q 41-50  (bottom-right answer block)
    ] as ColumnConfig[],

    options: ['A', 'B', 'C', 'D', 'E'],

    /** Normalised x pitch between consecutive option bubbles (5.5/210). */
    bubbleXStep: 5.5 / 210,     // ≈ 0.02619

    /** Normalised y pitch between consecutive question rows (7.5/297). */
    rowYStep: 7.5 / 297,        // ≈ 0.02525

    /**
     * Normalised bubble radius (2.2/210 of page width).
     * NOT inflated — tight circle keeps T/F labels (printed just above bubbles)
     * and adjacent-column text well outside the sampling area.
     */
    bubbleRadius: 2.2 / 210,   // ≈ 0.01048

    /**
     * A bubble must be at least this much darker (fill ratio) than the
     * page background to count as "marked".
     * 0.25 eliminates bubble-outline shadows and T/F text false-positives.
     */
    fillThreshold: 0.25,

    /**
     * The darkest bubble in a row must be at least this many times
     * darker than the second-darkest to be a clean single answer.
     * Lowered to 1.3 to handle slight ink spread around a filled bubble.
     */
    darknessDifferential: 1.3,
  },

  /**
   * Student ID bubble grid.
   *
   * From jsPDF drawStudentIdGrid():
   *   startX=40, digitStartX=41.2, gridTopY=59
   *   bubble centre x = 43.2 + digitIndex * 4.8  mm
   *   bubble centre y = 59   + rowIndex   * 6.2  mm
   *   rowLabels = ['1','2','3','4','5','6','7','8','9','0']
   *   bubbleRadius = 2.0mm
   */
  studentIdGrid: {
    /** Normalised x of bubble centre for digit column 0 (43.2/210). */
    digitStartX: 43.2 / 210,

    /** Normalised y of bubble centre for row 0  (digit '1') (59/297). */
    gridTopY: 59 / 297,

    /** Normalised x step between consecutive digit columns (4.8/210). */
    digitGap: 4.8 / 210,

    /** Normalised y step between consecutive digit rows (6.2/297). */
    rowGap: 6.2 / 297,

    /** Normalised bubble radius, inflated 20 % for robustness. */
    bubbleRadius: (2.0 / 210) * 1.2,

    /** Digit value for each row index 0-9. */
    rowDigits: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'] as string[],

    /**
     * Minimum fill ratio to accept a digit as marked.
     * Slightly lower than the answer-bubble threshold so lightly-filled
     * student ID bubbles are still detected.
     */
    fillThreshold: 0.20,
  },

  /**
   * Machine-readable paper-version marker.
   *
   * The visible "Key Version" bubble column was removed from the sheet so the
   * student cannot tell which version they hold; the version is printed as a
   * strip of solid 4 mm squares instead.
   *
   * From the jsPDF generator (lib/answer-sheet-version-code.ts):
   *   Slot centre x = 28 mm, slot centre y = 66 + index * 10 mm, 6 slots.
   *   Slot 0     : always printed (calibration / start mark)
   *   Slots 1-4  : version number, 4 bits, most significant bit first
   *   Slot 5     : even parity over the data bits
   *
   * The strip lies between 22 % and 40 % of the page height, well clear of the
   * corner-anchor search windows.
   */
  versionCode: {
    /** Normalised x of every slot centre (28/210). */
    centerX: 28 / 210,

    /** Normalised y of slot 0 centre (66/297). */
    firstCenterY: 66 / 297,

    /** Normalised y pitch between slots (10/297). */
    slotPitch: 10 / 297,

    /** Normalised half-size of the sampling window (2/210 of page width). */
    sampleHalf: 2 / 210,

    /** Number of slots: 1 start + 4 data + 1 parity. */
    totalSlots: 6,
    dataBits: 4,

    /** A slot counts as printed above this fill ratio. */
    fillThreshold: 0.35,
  },
} as const;

export type SheetConfig = typeof SHEET_CONFIG;
