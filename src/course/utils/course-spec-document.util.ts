import {
  normalizeCourseQualityAssessment,
  normalizeFacilityRows,
  primitiveText,
  type CourseQualityAssessmentRow,
  type CourseRequirement,
  type CourseTypeScope,
} from './course-spec-fields.util';
import { buildCloCodeResolver } from './clo-topic-matching.util';

/**
 * Deterministic helpers that read course-specification values straight from the
 * extracted document text (DOCX rows look like `| Label: value | ... |`; PDF text
 * is plain lines). Used to correct / backfill the AI extraction result.
 */

const CHECKED_GLYPHS = '☒☑✓✔✅■';
const ANY_BOX_GLYPHS = `☐□${CHECKED_GLYPHS}`;

/** Template filler text left in unfilled course specifications. */
export function isPlaceholderValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  const text = primitiveText(value).replace(/\s+/g, ' ').trim();
  if (!text) return true;
  if (/^[\s.()…_\-–—:/\\[\]]*$/.test(text)) return true;
  if (/\b(?:pick|click|tap|choose|select|enter|type)\b.*\b(?:date|here|text|number|item|value)\b/i.test(text)) {
    return true;
  }
  if (/^course specification version( number)?$/i.test(text)) return true;
  if (/^(?:n\/?a|none|nil|null|-+)$/i.test(text)) return true;
  return false;
}

const splitCells = (line: string) =>
  line.trim().startsWith('|')
    ? line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim())
    : [line.trim()];

const firstSegment = (value: string) =>
  (value.split(/\s*<br>\s*|\t/).find((part) => part.trim()) ?? '').trim();

const LABEL_PREFIX = /^[\p{L}][\p{L}\s./()]{0,40}[:：]/u;

/** Cuts at the next `Label:` on the same line (PDF text often has several per line). */
const cutAtNextLabel = (value: string) =>
  value.split(/\s+(?=[\p{L}][\p{L} ]{0,30}[:：])/u)[0].trim();

/** Value printed after `Label:` in the same cell / line, else the next cell or line. */
export function findLabeledValue(
  text: string,
  labels: RegExp,
  options: { requireColon?: boolean } = {},
): string | null {
  const requireColon = options.requireColon ?? true;
  const lines = text.split('\n');

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const cells = splitCells(lines[lineIndex]);
    for (let cellIndex = 0; cellIndex < cells.length; cellIndex++) {
      const cell = cells[cellIndex];
      const pattern = new RegExp(
        `(?:^|\\s|\\d\\.\\s*)(?:${labels.source})\\s*${requireColon ? '[:：]' : '[:：]?'}\\s*`,
        'i',
      );
      const match = pattern.exec(cell);
      if (!match) continue;

      const candidates = [
        cutAtNextLabel(firstSegment(cell.slice(match.index + match[0].length))),
      ];
      const neighbours = [cells[cellIndex + 1] ?? ''];
      if (cells.length === 1 && lineIndex + 1 < lines.length) {
        neighbours.push(splitCells(lines[lineIndex + 1]).find(Boolean) ?? '');
      }
      for (const neighbour of neighbours) {
        const segment = firstSegment(neighbour);
        if (segment && !LABEL_PREFIX.test(segment)) candidates.push(segment);
      }

      for (const candidate of candidates) {
        if (candidate && !isPlaceholderValue(candidate)) return candidate;
      }
      return null;
    }
  }
  return null;
}

const COURSE_CODE_LABEL = /course\s*code|رمز\s*المقرر|كود\s*المقرر/;

export function findCourseCodeInDocumentText(text: string): string | null {
  const value = findLabeledValue(text, COURSE_CODE_LABEL);
  if (!value) return null;
  const candidate = value.split(/\s{2,}/)[0].trim();
  if (
    candidate.length <= 40 &&
    /\d/.test(candidate) &&
    /^[\p{L}\p{N}][\p{L}\p{N}\s._/-]*$/u.test(candidate)
  ) {
    return candidate;
  }
  return null;
}

/**
 * The code printed after "Course Code:" wins over the AI value, which tends to
 * shorten or reorder it (e.g. "329CSS-3" → "CSS - 329"). The AI code is only
 * used when the document has no readable code.
 */
export function reconcileCourseCode(
  aiCode: unknown,
  documentCode: string | null,
): string | null {
  const ai = typeof aiCode === 'string' ? aiCode.trim() : '';
  return documentCode?.trim() || ai || null;
}

const GENERAL_INFO_LABELS: Record<string, RegExp> = {
  program: /program(?:me)?|البرنامج/,
  department: /department|القسم/,
  college: /college|faculty|الكلية/,
  institution: /institution|university|المؤسسة|الجامعة/,
  version: /version(?:\s*(?:no\.?|number))?|رقم\s*الإصدار|الإصدار/,
  lastRevisionDate: /last\s*revision\s*date|revision\s*date|تاريخ\s*آخر\s*مراجعة|تاريخ\s*المراجعة/,
};

/** An empty date cell otherwise picks up the next line (often a page number). */
const DATE_LIKE =
  /\d{1,4}\s*[-/.]\s*\d{1,2}|\b(?:1[34]|19|20)\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|[\u0600-\u06FF]{3,}/i;

const escapeGlyphs = (glyphs: string) => `[${glyphs}]`;

function sectionLines(text: string, heading: RegExp, maxLines = 16): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return [];
  return lines.slice(start, start + maxLines);
}

/**
 * Finds the option whose checkbox is ticked. Box position (before/after the
 * option word) is inferred per line; a lone tick between two options with no
 * empty boxes to compare against is ambiguous and yields null.
 */
function findCheckedOption<T extends string>(
  lines: string[],
  options: Array<{ value: T; pattern: string }>,
): T | null {
  const optionAlternation = options.map((option) => option.pattern).join('|');
  const optionRe = new RegExp(`(?:${optionAlternation})`, 'i');
  const optionAtEnd = new RegExp(`(${optionAlternation})[\\s|]*$`, 'i');
  const optionAtStart = new RegExp(`^[\\s|]*(${optionAlternation})`, 'i');
  const optionAtEndSameCell = new RegExp(`(${optionAlternation})\\s*$`, 'i');
  const optionAtStartSameCell = new RegExp(`^\\s*(${optionAlternation})`, 'i');
  const anyBox = new RegExp(escapeGlyphs(ANY_BOX_GLYPHS));
  const uncheckedBox = /[☐□]/;
  const checkedRe = new RegExp(escapeGlyphs(CHECKED_GLYPHS), 'g');
  const toValue = (word: string) =>
    options.find((option) => new RegExp(`^(?:${option.pattern})$`, 'i').test(word))
      ?.value ?? null;

  for (const line of lines) {
    if (!optionRe.test(line) || !new RegExp(escapeGlyphs(CHECKED_GLYPHS)).test(line)) {
      continue;
    }
    const firstBox = line.search(anyBox);
    const firstOption = line.search(optionRe);
    const hasUnchecked = uncheckedBox.test(line);

    for (const match of line.matchAll(checkedRe)) {
      const left = line.slice(0, match.index);
      const right = line.slice((match.index ?? 0) + match[0].length);
      const leftOption = optionAtEnd.exec(left)?.[1];
      const rightOption = optionAtStart.exec(right)?.[1];
      const leftSameCell = optionAtEndSameCell.exec(left)?.[1];
      const rightSameCell = optionAtStartSameCell.exec(right)?.[1];
      const pickOne = (a?: string, b?: string) => (a && !b ? a : b && !a ? b : undefined);

      let word: string | undefined;
      if (hasUnchecked) {
        word = firstBox < firstOption ? rightOption : leftOption;
      } else if (leftSameCell || rightSameCell) {
        word = pickOne(leftSameCell, rightSameCell);
      } else {
        word = pickOne(leftOption, rightOption);
      }
      const value = word ? toValue(word) : null;
      if (value) return value;
    }
  }
  return null;
}

const SCOPE_OPTIONS: Array<{ value: CourseTypeScope; pattern: string }> = [
  { value: 'UNIVERSITY', pattern: 'University|جامعة|الجامعة' },
  { value: 'COLLEGE', pattern: 'College|كلية|الكلية' },
  { value: 'DEPARTMENT', pattern: 'Department|قسم|القسم' },
  { value: 'TRACK', pattern: 'Track|مسار|المسار' },
  { value: 'OTHERS', pattern: 'Others?|أخرى|اخرى' },
];

const REQUIREMENT_OPTIONS: Array<{ value: CourseRequirement; pattern: string }> = [
  { value: 'REQUIRED', pattern: 'Required|إجباري|اجباري' },
  { value: 'ELECTIVE', pattern: 'Elective|اختياري' },
];

export function findCourseIdentification(text: string) {
  const lines = sectionLines(
    text,
    /course\s*identification|course\s*type|تعريف\s*المقرر|نوع\s*المقرر/i,
    14,
  );

  const creditLine = findLabeledValue(
    lines.join('\n'),
    /credit\s*hours?|الساعات\s*المعتمدة/,
    { requireColon: false },
  );
  const creditMatch = creditLine
    ? /^\d+(?:\s*\(\s*\d+(?:\s*[,،\-–]\s*\d+)*\s*\))?/.exec(creditLine.trim())
    : null;

  return {
    creditHoursDetail: creditMatch ? creditMatch[0].replace(/\s+/g, '') : null,
    courseTypeScope: findCheckedOption(lines, SCOPE_OPTIONS),
    courseRequirement: findCheckedOption(lines, REQUIREMENT_OPTIONS),
  };
}

type ContactHoursResult = {
  lectureHours: number | null;
  labHours: number | null;
  fieldHours: number | null;
  tutorialHours: number | null;
  otherContactHours: number | null;
  otherContactHoursLabel: string | null;
  totalContactHours: number | null;
};

const CONTACT_ACTIVITY_PATTERNS: Array<{
  key: Exclude<keyof ContactHoursResult, 'otherContactHoursLabel'>;
  pattern: RegExp;
}> = [
  { key: 'lectureHours', pattern: /^(?:lectures?|محاضرات|المحاضرات)$/i },
  { key: 'labHours', pattern: /^(?:lab(?:oratory)?(?:\s*\/\s*studio)?|studio|مختبر|معمل|المختبر|معمل\s*\/\s*استوديو)$/i },
  { key: 'fieldHours', pattern: /^(?:field(?:\s*work)?|ميداني|العمل\s*الميداني)$/i },
  { key: 'tutorialHours', pattern: /^(?:tutorials?|دروس\s*إضافية|تمارين)$/i },
  { key: 'otherContactHours', pattern: /^(?:others?|أخرى|اخرى)\b/i },
  { key: 'totalContactHours', pattern: /^(?:total|المجموع|الإجمالي)$/i },
];

export function findContactHours(text: string): ContactHoursResult {
  const result: ContactHoursResult = {
    lectureHours: null,
    labHours: null,
    fieldHours: null,
    tutorialHours: null,
    otherContactHours: null,
    otherContactHoursLabel: null,
    totalContactHours: null,
  };

  const lines = text.split('\n');
  const start = lines.findIndex(
    (line) =>
      /contact\s*hours/i.test(line) &&
      !line.trim().startsWith('|') &&
      !/teaching\s*mode/i.test(line),
  );
  if (start < 0) return result;

  const body = lines.slice(start + 1, start + 14);
  const activityOf = (cell: string) => {
    const label = cell.replace(/^\d+\s*\.?\s*/, '').trim();
    return { label, activity: CONTACT_ACTIVITY_PATTERNS.find((item) => item.pattern.test(label)) };
  };
  /** PDF: a value printed slightly lower than its label lands on its own line. */
  const loneNumber = (line: string | undefined) =>
    /^\|?\s*(\d+(?:\.\d+)?)\s*\|?$/.exec((line ?? '').trim())?.[1];

  for (let lineIndex = 0; lineIndex < body.length; lineIndex++) {
    const line = body[lineIndex];
    const found = Object.values(result).some((value) => value !== null);
    if (!line.trim()) {
      if (found) break;
      continue;
    }
    const isRow = line.trim().startsWith('|');
    if (!isRow && !activityOf(line).activity && loneNumber(line) === undefined) {
      if (found) break;
      continue;
    }

    const cells = isRow ? splitCells(line) : [line.trim()];
    for (let index = 0; index < cells.length; index++) {
      const { label, activity } = activityOf(cells[index]);
      if (!activity) continue;

      const valueCell =
        cells.slice(index + 1).find((cell) => /\d/.test(cell)) ??
        (index === cells.length - 1 && !activityOf(body[lineIndex + 1] ?? '').activity
          ? loneNumber(body[lineIndex + 1])
          : undefined);
      const hours = valueCell ? Number(/\d+(?:\.\d+)?/.exec(valueCell)?.[0]) : NaN;
      if (Number.isFinite(hours) && hours > 0) {
        result[activity.key] = Math.round(hours);
      }
      if (activity.key === 'otherContactHours') {
        const specified = label
          .replace(/^(?:others?|أخرى|اخرى)\s*(?:\(\s*specify\s*\)|\(\s*حدد\s*\))?\s*[:：-]?\s*/i, '')
          .trim();
        if (specified && !isPlaceholderValue(specified)) {
          result.otherContactHoursLabel = specified;
        }
      }
      break;
    }
  }

  return result;
}

const COURSE_CONTENT_HEADING = /course\s*content|محتوى\s*المقرر/i;
const NEXT_SECTION_AFTER_CONTENT =
  /^\s*(?:[D-H]\s*[.)-]\s*)?(?:students?\s+assessment|assessment\s+activities|learning\s+resources|أنشطة\s*تقييم|مصادر\s*التعلم)/i;
const ASSESSMENT_ACTIVITIES_HEADING =
  /students?\s+assessment\s+activities|assessment\s+activities|أنشطة\s*تقييم\s*الطلبة/i;
const NEXT_SECTION_AFTER_ASSESSMENTS =
  /^\s*(?:[E-H]\s*[.)-]\s*)?(?:learning\s+resources|references\s+and\s+learning|required\s+facilities|assessment\s+of\s+course\s+quality|مصادر\s*التعلم)/i;
const TOTAL_LABEL = /^(?:\d+\s*[.)]?\s*)?(?:total|المجموع|الإجمالي)\b/i;

/**
 * Lines of the table that follows `heading` (a non-table heading line, which
 * skips table-of-contents entries) up to the next section heading.
 */
function sectionTableLines(text: string, heading: RegExp, stop: RegExp): string[][] {
  const lines = text.split('\n');
  const sections: string[][] = [];
  for (let start = 0; start < lines.length; start++) {
    if (!heading.test(lines[start]) || lines[start].trim().startsWith('|')) continue;
    const body: string[] = [];
    for (const line of lines.slice(start + 1, start + 60)) {
      if (stop.test(line.replace(/^\|\s*/, ''))) break;
      body.push(line);
    }
    sections.push(body);
  }
  return sections;
}

/** Last number of the table's "Total" row (DOCX `| 6. | Total |  | 100% |` or PDF `Total 75`). */
function findSectionTotal(text: string, heading: RegExp, stop: RegExp): number | null {
  for (const body of sectionTableLines(text, heading, stop)) {
    for (const line of body) {
      const cells = splitCells(line).filter(Boolean);
      const totalIndex = cells.findIndex((cell) => TOTAL_LABEL.test(cell));
      if (totalIndex < 0) continue;
      const numbers = cells
        .slice(totalIndex)
        .join(' ')
        .replace(TOTAL_LABEL, '')
        .match(/\d+(?:\.\d+)?/g);
      const total = numbers ? Math.round(Number(numbers[numbers.length - 1])) : NaN;
      return Number.isFinite(total) && total > 0 ? total : null;
    }
  }
  return null;
}

/** "Total" row of the Course Content (topics) table, as printed in the document. */
export function findCourseContentTotal(text: string): number | null {
  return findSectionTotal(text, COURSE_CONTENT_HEADING, NEXT_SECTION_AFTER_CONTENT);
}

/** "Total" row of the Students Assessment Activities table (percentage), as printed. */
export function findAssessmentActivitiesTotal(text: string): number | null {
  return findSectionTotal(text, ASSESSMENT_ACTIVITIES_HEADING, NEXT_SECTION_AFTER_ASSESSMENTS);
}

const normalizeTitle = (value: unknown) =>
  primitiveText(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Numbering column cells: "1.", "No", "#", "م". */
const NUMBERING_CELL = /^(?:\d+\s*[.)]?|no\.?|#|م|رقم)$/i;

const firstTextCellIndex = (cells: string[]) =>
  cells.findIndex((cell) => /\p{L}/u.test(cell) && !NUMBERING_CELL.test(cell.trim()));

type AssessmentActivityRow = {
  title: string;
  timing: string | null;
  percentage: number | null;
};

/**
 * Rows of the Students Assessment Activities table as { title, timing, percentage }.
 * Timing is the cell after the activity; the percentage is the last cell.
 */
export function findAssessmentActivityRows(text: string): AssessmentActivityRow[] {
  for (const body of sectionTableLines(text, ASSESSMENT_ACTIVITIES_HEADING, NEXT_SECTION_AFTER_ASSESSMENTS)) {
    const rows: AssessmentActivityRow[] = [];
    for (const line of body) {
      if (!line.trim().startsWith('|')) continue;
      const cells = splitCells(line);
      const titleIndex = firstTextCellIndex(cells);
      if (titleIndex < 0 || cells.length < titleIndex + 3) continue;
      const title = cells[titleIndex].replace(/\s*<br>\s*/g, ' ').trim();
      if (TOTAL_LABEL.test(title) || /assessment\s+activities|percentage|timing/i.test(line)) continue;
      if (isPlaceholderValue(title)) continue;
      const timing = cells[titleIndex + 1].replace(/\s*<br>\s*/g, ' ').trim();
      rows.push({
        title,
        timing: timing && !isPlaceholderValue(timing) ? timing : null,
        percentage: firstNumber(cells[cells.length - 1]),
      });
    }
    if (rows.length > 0) return rows;
  }
  return [];
}

/** Same title → type mapping as the frontend (assign, quiz, lab, mid, exam). */
export function inferAssessmentType(title: string): string {
  const t = title.toLowerCase();
  if (/assign|homework|واجب/.test(t)) return 'ASSIGNMENT';
  if (/quiz|اختبار\s*قصير|اختبارات\s*قصيرة/.test(t)) return 'QUIZ';
  if (/\blab|معمل|مختبر/.test(t)) return 'LAB';
  if (/\bmid|منتصف|فصلي/.test(t)) return 'MID_TERM_EXAM';
  if (/exam|test|اختبار|امتحان/.test(t)) return 'FINAL_EXAM';
  return 'OTHER';
}

/** Document rows win (order, title, timing, percentage, type) when the table is readable. */
function applyAssessmentFallbacks(assessments: unknown, text: string): unknown {
  const documentRows = text ? findAssessmentActivityRows(text) : [];
  if (documentRows.length > 0) {
    return documentRows.map((row) => ({
      title: row.title,
      type: inferAssessmentType(row.title),
      percentage: row.percentage,
      timing: row.timing,
      duration: null,
      totalMarks: null,
      passMark: null,
      numberOfVersions: 2,
      difficulty: 'BALANCED',
    }));
  }

  return (Array.isArray(assessments) ? assessments : [])
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .filter((item) => !TOTAL_LABEL.test(primitiveText(item.title).trim()))
    .map((item) => ({ ...item, timing: toCleanText(item.timing) }));
}

const COURSE_QUALITY_HEADING = /assessment\s+of\s+course\s+quality|تقييم\s*جودة\s*المقرر/i;
const SPEC_APPROVAL_HEADING = /specification\s+approval|اعتماد\s*التوصيف|بيانات\s*اعتماد/i;
const NEXT_SECTION_AFTER_QUALITY =
  /^\s*(?:[G-H]\s*[.)-]\s*)?(?:specification\s+approval|اعتماد\s*التوصيف|بيانات\s*اعتماد)/i;
const END_OF_DOCUMENT = /(?!)/;

/**
 * First run of table rows in a section body (blank lines allowed, other text
 * ends it). `strict` also rejects text before the table (e.g. TOC entries).
 */
function firstTableBlock(body: string[], strict = false): string[] {
  const rows: string[] = [];
  for (const line of body) {
    if (line.trim().startsWith('|')) {
      rows.push(line);
    } else if (line.trim() && (strict || rows.length > 0)) {
      break;
    }
  }
  return rows;
}

const cellText = (value: string | undefined) => {
  const text = (value ?? '').replace(/\s*<br>\s*/g, '\n').trim();
  return text && !isPlaceholderValue(text) ? text : '';
};

/** Rows of the "Assessment of Course Quality" table (DOCX text only). */
export function findCourseQualityAssessment(text: string): CourseQualityAssessmentRow[] {
  for (const body of sectionTableLines(text, COURSE_QUALITY_HEADING, NEXT_SECTION_AFTER_QUALITY)) {
    const rows: Array<Record<string, string>> = [];
    for (const line of firstTableBlock(body, true)) {
      const cells = splitCells(line);
      if (cells.length < 3) continue;
      const [area, assessor, methods] = cells.slice(-3).map(cellText);
      if (/assessment\s*areas|مجالات\s*التقييم/i.test(area) && /assessor|المقيم/i.test(assessor)) {
        continue;
      }
      if (!area && /\betc\.?$/i.test(methods || assessor)) continue;
      rows.push({ area, assessor, methods });
    }
    const normalized = normalizeCourseQualityAssessment(rows, true) ?? [];
    if (normalized.length > 0) return normalized;
  }
  return [];
}

type SpecApproval = {
  approvalCouncil: string | null;
  approvalReferenceNo: string | null;
  approvalDate: string | null;
};

const APPROVAL_LABELS: Record<keyof SpecApproval, RegExp> = {
  approvalCouncil: /council\s*\/?\s*committee|council|committee|المجلس\s*\/?\s*اللجنة|المجلس|اللجنة|جهة\s*الاعتماد/,
  approvalReferenceNo: /reference\s*(?:no\.?|number|#)|رقم\s*المرجع|رقم\s*الجلسة|رقم\s*القرار/,
  approvalDate: /date|التاريخ|تاريخ\s*الاعتماد/,
};

/** COUNCIL / COMMITTEE, REFERENCE NO. and DATE rows of "Specification Approval Data" (DOCX text only). */
export function findSpecificationApproval(text: string): SpecApproval {
  const empty: SpecApproval = {
    approvalCouncil: null,
    approvalReferenceNo: null,
    approvalDate: null,
  };
  const keys = Object.keys(APPROVAL_LABELS) as Array<keyof SpecApproval>;
  const sections = sectionTableLines(text, SPEC_APPROVAL_HEADING, END_OF_DOCUMENT).reverse();
  for (const body of sections) {
    const result = { ...empty };
    let labelRows = 0;
    for (const row of firstTableBlock(body.slice(0, 12), true)) {
      const cells = splitCells(row);
      const labelCell = (cells[0] ?? '').replace(/\s*<br>\s*/g, ' ');
      const key = keys.find((name) =>
        new RegExp(`^\\s*(?:${APPROVAL_LABELS[name].source})\\s*[:：.]?\\s*$`, 'i').test(labelCell),
      );
      if (!key) continue;
      labelRows += 1;
      result[key] ??=
        cells
          .slice(1)
          .map((cell) => cellText(cell).replace(/\n+/g, ' '))
          .find(Boolean) || null;
    }
    if (labelRows > 0) return result;
  }
  return empty;
}

const firstNumber = (value: string | undefined): number | null => {
  const match = /\d+(?:\.\d+)?/.exec(value ?? '');
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
};

const joinBr = (value: string | undefined, separator: string) =>
  (value ?? '')
    .split(/\s*<br>\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join(separator);

/** Cells of the table that directly follows `heading` (TOC entries are skipped). */
function findSectionTable(text: string, heading: RegExp, stop: RegExp = END_OF_DOCUMENT): string[][] {
  for (const body of sectionTableLines(text, heading, stop)) {
    const rows = firstTableBlock(body, true);
    if (rows.length > 0) return rows.map(splitCells);
  }
  return [];
}

const NEXT_LABEL_CELL = /^(?:\d+\s*[.)-]\s*)?\p{L}[^:：]{0,120}[:：]\s*$/u;

/**
 * Value of a numbered single-cell label row such as `| 4. Course General Description: |`,
 * printed after the colon or in the next single-cell row.
 * undefined = label not in the document; null = label present but empty.
 */
export function findValueBelowLabel(text: string, label: RegExp): string | null | undefined {
  const lines = text.split('\n');
  const labelRe = new RegExp(`^(?:\\d+\\s*[.)-]\\s*)?(?:${label.source})[^:：]*[:：]\\s*(.*)$`, 'iu');
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trim().startsWith('|')) continue;
    const cells = splitCells(lines[index]).filter(Boolean);
    if (cells.length !== 1) continue;
    const match = labelRe.exec(cells[0]);
    if (!match) continue;

    const inline = match[1].replace(/^\(\s*([\s\S]*?)\s*\)$/, '$1').trim();
    if (inline && !isPlaceholderValue(inline)) return joinBr(inline, '\n');

    const next = lines[index + 1] ?? '';
    if (!next.trim().startsWith('|')) return null;
    const nextCells = splitCells(next).filter(Boolean);
    if (nextCells.length === 0 || NEXT_LABEL_CELL.test(nextCells[0])) return null;
    const value = nextCells.map((cell) => joinBr(cell, '\n')).join('\n').trim();
    return value && !isPlaceholderValue(value) ? value : null;
  }
  return undefined;
}

const LIST_SEPARATOR = /\s*(?:\n|,|،|;|؛|&|\band\b)\s*/i;

/** Pre-/co-requisite list below its label; undefined when the label is missing. */
export function findRequisites(text: string, label: RegExp): string[] | undefined {
  const value = findValueBelowLabel(text, label);
  if (value === undefined) return undefined;
  if (value === null) return [];
  return value
    .split(LIST_SEPARATOR)
    .map((item) => item.trim())
    .filter((item) => item && !isPlaceholderValue(item));
}

const CLO_HEADING = /course\s+learning\s+outcomes|مخرجات\s*التعلم\s*للمقرر|مخرجات\s*تعلم\s*المقرر/i;
const NEXT_SECTION_AFTER_CLOS = /^\s*(?:[C-H]\s*[.)-]\s*)?(?:course\s+content|محتوى\s*المقرر)/i;
const CLO_CODE = /^\d+(?:\.\d+)+$/;
const PLO_CODES =
  /^[A-Z\u0600-\u06FF]{1,4}\s*\d+(?:\.\d+)?(?:\s*(?:,|،|;|&|\/|and|و)?\s*[A-Z\u0600-\u06FF]{1,4}\s*\d+(?:\.\d+)?)*$/i;

type CloCategory = 'KNOWLEDGE' | 'SKILLS' | 'VALUES';

const categoryFromText = (value: string): CloCategory | null => {
  if (/knowledge|understanding|معرف|فهم/i.test(value)) return 'KNOWLEDGE';
  if (/skill|مهار/i.test(value)) return 'SKILLS';
  if (/value|autonomy|responsib|competenc|قيم|استقلال|مسؤولي|كفاء/i.test(value)) return 'VALUES';
  return null;
};

const CATEGORY_BY_DOMAIN: Record<string, CloCategory> = {
  '1': 'KNOWLEDGE',
  '2': 'SKILLS',
  '3': 'VALUES',
};

export type DocumentClo = {
  code: string;
  category: CloCategory | '';
  programCLOCode: string | null;
  description: string;
  teachingStrategies: string[];
  assessmentMethods: string[];
};

/**
 * CLO table rows (Code | CLO | PLO code | Teaching Strategies | Assessment Methods).
 * Domain rows (1.0 Knowledge…) set the category; rows without a PLO code shift left.
 */
export function findCourseClos(text: string): DocumentClo[] {
  const rows = findSectionTable(text, CLO_HEADING, NEXT_SECTION_AFTER_CLOS);
  const clos: DocumentClo[] = [];
  const seen = new Set<string>();
  const domainCategories = new Map<string, CloCategory>();

  for (const cells of rows) {
    const code = (cells[0] ?? '').replace(/\s+/g, '');
    if (!CLO_CODE.test(code)) continue;
    const description = joinBr(cells[1], ' ');
    const domain = code.split('.')[0];

    if (/\.0+$/.test(code)) {
      const category = categoryFromText(description);
      if (category) domainCategories.set(domain, category);
      continue;
    }
    if (!description || isPlaceholderValue(description) || !/\p{L}/u.test(description)) continue;
    if (seen.has(code)) continue;
    seen.add(code);

    const rest = cells.slice(2);
    const hasPlo = PLO_CODES.test(joinBr(rest[0], ', '));
    const [plo, strategies, methods] = hasPlo ? rest : [null, rest[0], rest[1]];
    clos.push({
      code,
      category: domainCategories.get(domain) ?? CATEGORY_BY_DOMAIN[domain] ?? '',
      programCLOCode: plo ? joinBr(plo, ', ') || null : null,
      description,
      teachingStrategies: normalizeStrategyList(strategies ?? ''),
      assessmentMethods: normalizeStrategyList(methods ?? ''),
    });
  }
  return clos;
}

export type DocumentTopic = { topicNumber: number; title: string; contactHours: number | null };

/** Course Content rows in order (numbering is re-applied: Word auto-numbers are not in the text). */
export function findCourseTopics(text: string): DocumentTopic[] {
  const topics: DocumentTopic[] = [];
  for (const cells of findSectionTable(text, COURSE_CONTENT_HEADING, NEXT_SECTION_AFTER_CONTENT)) {
    const titleIndex = firstTextCellIndex(cells);
    if (titleIndex < 0) continue;
    const title = joinBr(cells[titleIndex], ' ');
    if (TOTAL_LABEL.test(title) || cells.some((cell) => /list\s+of\s+topics|قائمة\s*الموضوعات/i.test(cell))) {
      continue;
    }
    if (isPlaceholderValue(title)) continue;
    const hours = firstNumber(cells.slice(titleIndex + 1).find((cell) => /\d/.test(cell)));
    topics.push({
      topicNumber: topics.length + 1,
      title,
      contactHours: hours && hours > 0 ? Math.round(hours) : null,
    });
  }
  return topics;
}

const TEACHING_MODE_HEADING = /teaching\s+mode|نمط\s*التعليم|أنماط\s*التعليم/i;

/** Teaching-mode rows that are filled in (hours, percentage or a ticked box); null when there is no table. */
export function findTeachingModes(text: string) {
  const table = findSectionTable(text, TEACHING_MODE_HEADING);
  if (table.length === 0) return null;
  const modes: Array<{ modeOfInstruction: string; contactHours: number | null; percentage: number | null }> = [];
  for (const cells of table) {
    const modeIndex = firstTextCellIndex(cells);
    if (modeIndex < 0) continue;
    const [first, ...rest] = (cells[modeIndex] ?? '')
      .replace(new RegExp(escapeGlyphs(ANY_BOX_GLYPHS), 'g'), '')
      .split(/\s*<br>\s*/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (!first || /mode\s+of\s+instruction|نمط\s*التعليم/i.test(first)) continue;
    const values = cells.slice(modeIndex + 1);
    const contactHours = firstNumber(values[0]);
    const percentage = firstNumber(values[1]);
    const ticked = new RegExp(escapeGlyphs(CHECKED_GLYPHS)).test(cells.join(' '));
    if (contactHours === null && percentage === null && !ticked) continue;
    modes.push({
      modeOfInstruction: rest.length ? `${first} (${rest.join(', ')})` : first,
      contactHours: contactHours !== null ? Math.round(contactHours) : null,
      percentage,
    });
  }
  return modes;
}

const FACILITIES_HEADING = /required\s+facilities|المرافق\s*والتجهيزات\s*المطلوبة|المرافق\s*والتجهيزات/i;

/** Required Facilities and Equipment rows with resources filled in; null when there is no table. */
export function findFacilities(text: string): Array<{ item: string; resources: string }> | null {
  const table = findSectionTable(text, FACILITIES_HEADING);
  if (table.length === 0) return null;
  const rows: Array<{ item: string; resources: string }> = [];
  for (const cells of table) {
    if (cells.length < 2) continue;
    const item = (cells[0] ?? '').split(/\s*<br>\s*/)[0].trim();
    const resources = joinBr(cells[cells.length - 1], '\n');
    if (!item || /^items?$|^العناصر$|^البنود$/i.test(item)) continue;
    if (!resources || isPlaceholderValue(resources)) continue;
    rows.push({ item, resources });
  }
  return rows;
}

const cloCodeOrder = (a: string, b: string) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.localeCompare(b);
};

const mappedCodesOf = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [])
    .map((item) =>
      item && typeof item === 'object'
        ? primitiveText((item as Record<string, unknown>).code)
        : primitiveText(item),
    )
    .map((code) => code.trim())
    .filter(Boolean);

/** Known CLO codes only; program codes such as "K1" resolve to their CLO code. */
const resolveMappedCodes = (
  value: unknown,
  resolve: (code: unknown) => string | null,
  keepUnknown: boolean,
) =>
  [
    ...new Set(
      mappedCodesOf(value)
        .map((code) => resolve(code) ?? (keepUnknown ? code : null))
        .filter((code): code is string => Boolean(code)),
    ),
  ].sort(cloCodeOrder);

/**
 * Document topics win; CLO mappings come from the AI topic with the same
 * title, a title containing the other, or the same position when the counts
 * match. Topics left unmapped are filled later by the CLO–topic matcher.
 */
function mergeTopics(
  documentTopics: DocumentTopic[],
  aiTopics: unknown,
  resolve: (code: unknown) => string | null,
  keepUnknown: boolean,
) {
  const ai = (Array.isArray(aiTopics) ? aiTopics : []).filter(
    (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object',
  );
  const aiKeys = ai.map((item) => normalizeTitle(item.title ?? item.topic));
  const sameCount = ai.length === documentTopics.length;
  return documentTopics.map((topic, index) => {
    const key = normalizeTitle(topic.title);
    let matchIndex = aiKeys.indexOf(key);
    if (matchIndex < 0 && key.length >= 4) {
      matchIndex = aiKeys.findIndex(
        (aiKey) => aiKey.length >= 4 && (aiKey.includes(key) || key.includes(aiKey)),
      );
    }
    const match = matchIndex >= 0 ? ai[matchIndex] : sameCount ? ai[index] : undefined;
    return { ...topic, mappedClos: resolveMappedCodes(match?.mappedClos, resolve, keepUnknown) };
  });
}

const toPositiveInt = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(primitiveText(value).replace(/[^\d.]/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
};

const toCleanText = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const text = primitiveText(value).replace(/\s+/g, ' ').trim();
  return text && !isPlaceholderValue(text) ? text : null;
};

/** One entry per strategy/method; splits AI strings that still contain row breaks. */
export function normalizeStrategyList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : value == null ? [] : [value];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    for (const part of primitiveText(item).split(/\s*<br>\s*|\r?\n|;|؛|•|▪|●/)) {
      const text = part.replace(/^\s*(?:[-*–]|\d+[.)])\s+/, '').replace(/\s+/g, ' ').trim();
      if (!text || isPlaceholderValue(text)) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(text);
    }
  }
  return result;
}

/**
 * Cleans the AI extraction result and backfills/corrects course-spec fields
 * that can be read deterministically from the document text.
 */
export function applyCourseSpecDocumentFallbacks(
  result: Record<string, unknown>,
  documentText: string | null | undefined,
  options: { source?: 'docx' | 'pdf' } = {},
): Record<string, unknown> {
  const text = documentText ?? '';
  const next: Record<string, unknown> = { ...result };

  /**
   * DOCX rows (`| … |`) are exact cells, so the document wins. PDF rows are
   * rebuilt from glyph positions: single-line label/value cells are reliable,
   * but wrapped multi-line cells are not, so PDF tables stay with the AI.
   */
  const exact = options.source !== 'pdf' && /^\|/m.test(text);
  const pick = <T>(documentValue: T | null | undefined, aiValue: T | null | undefined) =>
    (exact ? (documentValue ?? aiValue) : (aiValue ?? documentValue)) ?? null;

  next.code = reconcileCourseCode(result.code, text ? findCourseCodeInDocumentText(text) : null);
  next.title =
    pick(text ? findLabeledValue(text, COURSE_TITLE_LABEL) : null, toCleanText(result.title)) ?? '';

  for (const [key, label] of Object.entries(GENERAL_INFO_LABELS)) {
    const valid = (value: string | null) =>
      value && key === 'lastRevisionDate' && !DATE_LIKE.test(value) ? null : value;
    next[key] = pick(
      valid(text ? findLabeledValue(text, label) : null),
      valid(toCleanText(result[key])),
    );
  }

  for (const [key, label] of Object.entries(BELOW_LABEL_FIELDS)) {
    const documentValue = text ? findValueBelowLabel(text, label) : undefined;
    const aiValue = toCleanMultiline(result[key]);
    next[key] =
      exact || !aiValue ? (documentValue === undefined ? aiValue : documentValue) : aiValue;
  }

  for (const [key, label] of Object.entries(REQUISITE_LABELS)) {
    const documentValue = text ? findRequisites(text, label) : undefined;
    const aiValue = normalizeTextList(result[key]);
    next[key] = exact || aiValue.length === 0 ? (documentValue ?? aiValue) : aiValue;
  }

  const identification = text
    ? findCourseIdentification(text)
    : { creditHoursDetail: null, courseTypeScope: null, courseRequirement: null };
  next.creditHoursDetail =
    identification.creditHoursDetail ?? toCleanText(result.creditHoursDetail);
  next.courseTypeScope = identification.courseTypeScope ?? result.courseTypeScope ?? null;
  next.courseRequirement = identification.courseRequirement ?? result.courseRequirement ?? null;
  next.courseTypeOther =
    primitiveText(next.courseTypeScope).toUpperCase() === 'OTHERS'
      ? toCleanText(result.courseTypeOther)
      : null;

  next.creditHours =
    (typeof next.creditHoursDetail === 'string'
      ? toPositiveInt(/^\d+/.exec(next.creditHoursDetail)?.[0])
      : null) ?? toPositiveInt(result.creditHours);

  const documentModes = exact ? findTeachingModes(text) : null;
  next.teachingModes = documentModes ?? (Array.isArray(result.teachingModes) ? result.teachingModes : []);

  const documentFacilities = exact ? findFacilities(text) : null;
  next.requiredFacilitiesAndEquipment =
    documentFacilities ?? normalizeFacilityRows(result.requiredFacilitiesAndEquipment);

  const contact = text ? findContactHours(text) : null;
  const hourKeys = [
    'lectureHours',
    'labHours',
    'fieldHours',
    'tutorialHours',
    'otherContactHours',
    'totalContactHours',
  ] as const;
  for (const key of hourKeys) {
    next[key] = contact?.[key] ?? toPositiveInt(result[key]);
  }
  next.otherContactHoursLabel =
    contact?.otherContactHoursLabel ?? toCleanText(result.otherContactHoursLabel);

  if (next.totalContactHours == null) {
    const sum = hourKeys
      .filter((key) => key !== 'totalContactHours')
      .reduce((acc, key) => acc + (Number(next[key]) || 0), 0);
    next.totalContactHours = sum > 0 ? sum : null;
  }

  next.topicsTotalHours =
    (text ? findCourseContentTotal(text) : null) ?? toPositiveInt(result.topicsTotalHours);
  next.assessmentsTotalPercentage =
    (text ? findAssessmentActivitiesTotal(text) : null) ??
    toPositiveInt(result.assessmentsTotalPercentage);
  next.assessments = applyAssessmentFallbacks(result.assessments, exact ? text : '');

  const documentQuality = exact ? findCourseQualityAssessment(text) : [];
  next.courseQualityAssessment =
    documentQuality.length > 0
      ? documentQuality
      : (normalizeCourseQualityAssessment(result.courseQualityAssessment ?? [], true) ?? []);

  const approval = text
    ? findSpecificationApproval(text)
    : { approvalCouncil: null, approvalReferenceNo: null, approvalDate: null };
  for (const key of ['approvalCouncil', 'approvalReferenceNo', 'approvalDate'] as const) {
    next[key] = pick(approval[key], toCleanText(result[key]));
  }

  if (Array.isArray(result.references)) {
    next.references = result.references.filter((reference) => {
      if (!reference || typeof reference !== 'object') return false;
      const title = primitiveText((reference as Record<string, unknown>).title).trim();
      return !isPlaceholderValue(title) && !/^(?:note|ملاحظة)\s*[:：]/i.test(title);
    });
  }

  const documentClos = exact ? findCourseClos(text) : [];
  const clos: Array<Record<string, unknown>> =
    documentClos.length > 0
      ? documentClos
      : (Array.isArray(result.clos) ? result.clos : [])
          .filter((clo): clo is Record<string, unknown> => Boolean(clo) && typeof clo === 'object')
          .map((row) => ({
            ...row,
            teachingStrategies: normalizeStrategyList(row.teachingStrategies),
            assessmentMethods: normalizeStrategyList(row.assessmentMethods),
          }));
  next.clos = clos;
  const resolveCloCode = buildCloCodeResolver(
    clos.map((clo) => ({
      code: primitiveText(clo.code).trim(),
      programCLOCode: primitiveText(clo.programCLOCode).trim(),
    })),
  );
  const keepUnknownCodes = clos.length === 0;

  const documentTopics = exact ? findCourseTopics(text) : [];
  next.topics =
    documentTopics.length > 0
      ? mergeTopics(documentTopics, result.topics, resolveCloCode, keepUnknownCodes)
      : (Array.isArray(result.topics) ? result.topics : [])
          .filter((topic): topic is Record<string, unknown> => Boolean(topic) && typeof topic === 'object')
          .map((topic) => ({
            ...topic,
            mappedClos: resolveMappedCodes(topic.mappedClos, resolveCloCode, keepUnknownCodes),
          }));

  return next;
}

const COURSE_TITLE_LABEL = /course\s*title|course\s*name|اسم\s*المقرر|عنوان\s*المقرر/;

const BELOW_LABEL_FIELDS: Record<string, RegExp> = {
  level: /level\s*\/\s*year|level|المستوى/,
  description: /course\s+general\s+description|general\s+description|course\s+description|الوصف\s*العام|وصف\s*المقرر/,
  mainObjective: /course\s+main\s+objective|main\s+objective|الهدف\s*الرئيس|الأهداف\s*الرئيسة/,
};

const REQUISITE_LABELS: Record<string, RegExp> = {
  prerequisites: /pre-?\s*requi(?:rements?|sites?)|المتطلبات\s*السابقة/,
  coRequisites: /co-?\s*requi(?:rements?|sites?)|المتطلبات\s*المتزامنة|المتطلبات\s*المصاحبة/,
};

const toCleanMultiline = (value: unknown): string | null => {
  const text = primitiveText(value).trim();
  return text && !isPlaceholderValue(text) ? text : null;
};

const normalizeTextList = (value: unknown): string[] =>
  (Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [])
    .map((item) => primitiveText(item).trim())
    .filter((item) => item && !isPlaceholderValue(item));
