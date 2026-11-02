import * as XLSX from 'xlsx';

/**
 * Course marks workbook (one tab per assessment). The frontend builds the
 * styled template (lib/course-workbook.ts); this module reads it back.
 * Rows are located by their column-A label, never by fixed row numbers, so a
 * teacher may duplicate a tab or insert spare rows without breaking import.
 */

export const WORKBOOK_SOURCE = 'COURSE_WORKBOOK';

/** Stored question types; the workbook itself only offers MCQ and TRUE_FALSE. */
export type WorkbookQuestionType = 'MCQ' | 'TRUE_FALSE' | 'SHORT_ANSWER' | 'CODING' | 'MATH';

const ROSTER_SHEET_KEYS = new Set(['students', 'roster', 'studentlist']);
/** Overview tabs of the template — never assessments, even though they mention assessment types. */
const RESERVED_SHEET_KEYS = new Set(['instructions', 'summary', 'course', 'clos', 'lookups']);

const META_KEYS = {
  code: ['assessmentcode', 'code'],
  type: ['assessmenttype', 'type'],
  title: ['assessmenttitle', 'title'],
  weight: ['weight', 'weightpercent', 'weightpct'],
} as const;

const QUESTION_ROW_KEYS = {
  questionId: ['questionid'],
  label: ['question', 'questions', 'questionnumber'],
  clo: ['clocode', 'clo', 'clocodes'],
  max: ['maxmarks', 'marks', 'maxmark', 'points'],
  type: ['questiontype'],
  text: ['questiontext', 'description'],
} as const;

const MARKS_TAIL_KEYS = new Set(['total', 'percent', 'percentage', 'status', 'grade']);

export type ParsedRosterRow = {
  sheetName: string;
  rowNumber: number;
  studentId: string;
  name: string;
  section: string;
  departement: string;
};

export type ParsedQuestion = {
  /** Spreadsheet column letter (E, F, …) for messages. */
  column: string;
  label: string;
  questionId: number | null;
  questionIdRaw: string;
  cloCodes: string[];
  maxMarks: number | null;
  maxMarksRaw: string;
  typeRaw: string;
  text: string;
};

export type ParsedMark = number | null | { invalid: string };

export type ParsedMarkRow = {
  rowNumber: number;
  studentId: string;
  name: string;
  section: string;
  departement: string;
  marks: ParsedMark[];
};

export type ParsedAssessmentSheet = {
  sheetName: string;
  code: string;
  type: string;
  title: string;
  weightRaw: string;
  questions: ParsedQuestion[];
  rows: ParsedMarkRow[];
  /** Structural problems (missing label rows, etc.). */
  errors: string[];
};

export type ParsedCourseWorkbook = {
  roster: ParsedRosterRow[];
  assessments: ParsedAssessmentSheet[];
};

export function normalizeLabel(value: unknown) {
  return cellText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export function cellText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
  }
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return '';
}

export function cellNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/,/g, '.').replace(/[%\s]/g, '').trim();
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/** "1.1, 2.3" / "1.1;2.3" / "1.1 | 2.3" → ["1.1", "2.3"] */
export function splitCloCodes(raw: string) {
  return Array.from(
    new Set(
      raw
        .split(/[,;|/\n]+/)
        .map((code) => code.trim())
        .filter(Boolean),
    ),
  );
}

export function normalizeQuestionType(
  raw: string,
  fallback: WorkbookQuestionType = 'MCQ',
): WorkbookQuestionType | null {
  const key = normalizeLabel(raw);
  if (!key) return fallback;
  if (['mcq', 'multiplechoice', 'choice', 'qcm'].includes(key)) return 'MCQ';
  if (['truefalse', 'tf', 'trueorfalse', 'vf'].includes(key)) return 'TRUE_FALSE';
  return null;
}

const ABSENT_MARKS = new Set(['', '-', '—', 'abs', 'absent', 'na', 'n/a', 'x']);

function parseMark(value: unknown): ParsedMark {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : { invalid: String(value) };
  const text = cellText(value);
  if (ABSENT_MARKS.has(text.toLowerCase())) return null;
  const parsed = cellNumber(text);
  return parsed == null ? { invalid: text } : parsed;
}

type SheetGrid = {
  get: (row: number, col: number) => unknown;
  firstRow: number;
  lastRow: number;
  lastCol: number;
};

function gridOf(sheet: XLSX.WorkSheet): SheetGrid | null {
  if (!sheet['!ref']) return null;
  const range = XLSX.utils.decode_range(sheet['!ref']);
  return {
    get: (row, col) => {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: col })] as XLSX.CellObject | undefined;
      if (cell?.t === 'e') return cell.w ?? '#ERROR';
      return cell?.v ?? null;
    },
    firstRow: range.s.r,
    lastRow: range.e.r,
    lastCol: range.e.c,
  };
}

function findLabelRow(grid: SheetGrid, keys: readonly string[], fromRow = grid.firstRow) {
  for (let row = fromRow; row <= grid.lastRow; row += 1) {
    if (keys.includes(normalizeLabel(grid.get(row, 0)))) return row;
  }
  return -1;
}

/** Header row of the marks grid: column A "Student ID" plus at least one other header. */
function findMarksHeaderRow(grid: SheetGrid) {
  for (let row = grid.firstRow; row <= grid.lastRow; row += 1) {
    if (normalizeLabel(grid.get(row, 0)) !== 'studentid') continue;
    for (let col = 1; col <= grid.lastCol; col += 1) {
      if (cellText(grid.get(row, col))) return row;
    }
  }
  return -1;
}

function headerColumns(grid: SheetGrid, row: number) {
  const columns = new Map<string, number>();
  for (let col = 0; col <= grid.lastCol; col += 1) {
    const key = normalizeLabel(grid.get(row, col));
    if (key && !columns.has(key)) columns.set(key, col);
  }
  return columns;
}

function pickColumn(columns: Map<string, number>, keys: string[]) {
  for (const key of keys) {
    const col = columns.get(key);
    if (col != null) return col;
  }
  return -1;
}

function parseRoster(sheetName: string, grid: SheetGrid): ParsedRosterRow[] {
  const header = findMarksHeaderRow(grid);
  if (header < 0) return [];
  const columns = headerColumns(grid, header);
  const nameCol = pickColumn(columns, ['studentname', 'name', 'fullname']);
  const sectionCol = pickColumn(columns, ['section', 'group']);
  const deptCol = pickColumn(columns, ['departement', 'department', 'dept']);
  const rows: ParsedRosterRow[] = [];
  for (let row = header + 1; row <= grid.lastRow; row += 1) {
    const studentId = cellText(grid.get(row, 0));
    if (!studentId) continue;
    rows.push({
      sheetName,
      rowNumber: row + 1,
      studentId,
      name: nameCol >= 0 ? cellText(grid.get(row, nameCol)) : '',
      section: sectionCol >= 0 ? cellText(grid.get(row, sectionCol)) : '',
      departement: deptCol >= 0 ? cellText(grid.get(row, deptCol)) : '',
    });
  }
  return rows;
}

function parseAssessmentSheet(sheetName: string, grid: SheetGrid): ParsedAssessmentSheet {
  const errors: string[] = [];
  const meta = (keys: readonly string[]) => {
    const row = findLabelRow(grid, keys);
    return row >= 0 ? cellText(grid.get(row, 1)) : '';
  };

  const marksHeader = findMarksHeaderRow(grid);
  const labelRow = findLabelRow(grid, QUESTION_ROW_KEYS.label);
  const cloRow = findLabelRow(grid, QUESTION_ROW_KEYS.clo);
  const maxRow = findLabelRow(grid, QUESTION_ROW_KEYS.max);
  const idRow = findLabelRow(grid, QUESTION_ROW_KEYS.questionId);
  const typeRow = findLabelRow(grid, QUESTION_ROW_KEYS.type);
  const textRow = findLabelRow(grid, QUESTION_ROW_KEYS.text);

  if (marksHeader < 0) errors.push('Missing the "Student ID" header row of the marks grid.');
  if (cloRow < 0) errors.push('Missing the "CLO code" row.');
  if (maxRow < 0) errors.push('Missing the "Max marks" row.');

  const questions: ParsedQuestion[] = [];
  const questionCols: number[] = [];
  const columns = marksHeader >= 0 ? headerColumns(grid, marksHeader) : new Map<string, number>();
  const nameCol = pickColumn(columns, ['studentname', 'name', 'fullname']);
  const sectionCol = pickColumn(columns, ['section', 'group']);
  const deptCol = pickColumn(columns, ['departement', 'department', 'dept']);
  const fixedCols = new Set([0, nameCol, sectionCol, deptCol].filter((col) => col >= 0));

  if (marksHeader >= 0) {
    const firstQuestionCol = Math.max(...Array.from(fixedCols)) + 1;
    for (let col = firstQuestionCol; col <= grid.lastCol; col += 1) {
      const header = cellText(grid.get(marksHeader, col));
      if (MARKS_TAIL_KEYS.has(normalizeLabel(header))) break;
      const labelCell = labelRow >= 0 ? cellText(grid.get(labelRow, col)) : '';
      const label = header || labelCell;
      const maxRaw = maxRow >= 0 ? cellText(grid.get(maxRow, col)) : '';
      const cloRaw = cloRow >= 0 ? cellText(grid.get(cloRow, col)) : '';
      const idRaw = idRow >= 0 ? cellText(grid.get(idRow, col)) : '';
      if (!label && !maxRaw && !cloRaw && !idRaw) continue;
      const idNumber = cellNumber(idRaw);
      questions.push({
        column: XLSX.utils.encode_col(col),
        label: label || `Q${questions.length + 1}`,
        questionId:
          idNumber != null && Number.isInteger(idNumber) && idNumber > 0 ? idNumber : null,
        questionIdRaw: idRaw,
        cloCodes: splitCloCodes(cloRaw),
        maxMarks: cellNumber(maxRaw),
        maxMarksRaw: maxRaw,
        typeRaw: typeRow >= 0 ? cellText(grid.get(typeRow, col)) : '',
        text: textRow >= 0 ? cellText(grid.get(textRow, col)) : '',
      });
      questionCols.push(col);
    }
  }

  const rows: ParsedMarkRow[] = [];
  if (marksHeader >= 0) {
    for (let row = marksHeader + 1; row <= grid.lastRow; row += 1) {
      const studentId = cellText(grid.get(row, 0));
      const marks = questionCols.map((col) => parseMark(grid.get(row, col)));
      const hasMarks = marks.some((mark) => mark !== null);
      if (!studentId && !hasMarks) continue;
      rows.push({
        rowNumber: row + 1,
        studentId,
        name: nameCol >= 0 ? cellText(grid.get(row, nameCol)) : '',
        section: sectionCol >= 0 ? cellText(grid.get(row, sectionCol)) : '',
        departement: deptCol >= 0 ? cellText(grid.get(row, deptCol)) : '',
        marks,
      });
    }
  }

  return {
    sheetName,
    code: meta(META_KEYS.code),
    type: meta(META_KEYS.type),
    title: meta(META_KEYS.title),
    weightRaw: meta(META_KEYS.weight),
    questions,
    rows,
    errors,
  };
}

export function parseCourseWorkbook(buffer: Buffer): ParsedCourseWorkbook {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellFormula: false, cellHTML: false });
  const roster: ParsedRosterRow[] = [];
  const assessments: ParsedAssessmentSheet[] = [];

  for (const sheetName of workbook.SheetNames) {
    const grid = gridOf(workbook.Sheets[sheetName]);
    if (!grid) continue;
    const sheetKey = normalizeLabel(sheetName);
    if (ROSTER_SHEET_KEYS.has(sheetKey)) {
      roster.push(...parseRoster(sheetName, grid));
      continue;
    }
    if (RESERVED_SHEET_KEYS.has(sheetKey)) continue;
    if (findLabelRow(grid, ['assessmenttype']) < 0) continue;
    assessments.push(parseAssessmentSheet(sheetName, grid));
  }

  return { roster, assessments };
}
