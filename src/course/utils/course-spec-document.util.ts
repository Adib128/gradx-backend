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

const ASSESSMENT_FOOTNOTE =
  /^\*?assessment\s+activities\b.*\bi\.?e\.?\b|written\s+test.*oral\s+test|oral\s+presentation.*group\s+project/i;

/** Grade-weight cell: prefer an explicit % value in 0..100 over a bare trailing number. */
function parseAssessmentPercentageCell(
  cells: string[],
  titleIndex: number,
): number | null {
  for (let index = cells.length - 1; index > titleIndex; index -= 1) {
    const cell = (cells[index] ?? '').replace(/\s*<br>\s*/g, ' ').trim();
    if (!cell) continue;
    const hasPercentSign = /%/.test(cell);
    const bareWeight = /^(?:\d+(?:\.\d+)?)\s*%?$/.test(cell);
    if (!hasPercentSign && !bareWeight) continue;
    const parsed = firstNumber(cell);
    if (parsed == null || parsed < 0 || parsed > 100) continue;
    return Math.round(parsed);
  }
  return null;
}

const isAssessmentHeaderLine = (line: string, cells: string[]) => {
  const joined = cells.join(' ');
  return (
    /assessment\s+activities|percentage|timing/i.test(joined) &&
    (/no\.?|#|رقم/i.test(joined) || /percentage\s+of\s+total/i.test(joined))
  );
};

const isTimingCell = (value: string) => {
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return false;
  if (/^(?:\d+(?:\.\d+)?)\s*%$/.test(text)) return false;
  return /^(?:weeks?|tbd|w\b)/i.test(text) || /\bweek\b|\btbd\b/i.test(text);
};

const isPercentWeightCell = (value: string) => {
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return false;
  if (!/%/.test(text) && !/^(?:\d+(?:\.\d+)?)$/.test(text)) return false;
  const parsed = firstNumber(text);
  return parsed != null && parsed >= 0 && parsed <= 100;
};

/** Pull a trailing "Week(s) …" / TBD timing off a mashed title+timing cell. */
function peelTrailingTiming(text: string): { title: string; timing: string | null } {
  const cleaned = text.replace(/\s+/g, ' ').trim().replace(/,\s*$/, '');
  const match = cleaned.match(
    /^(.*?)\s+((?:Weeks?\s+.+|TBD(?:\b.*)?))$/i,
  );
  if (!match) return { title: cleaned, timing: null };
  const title = match[1].replace(/[(\[]\s*$/, '').trim();
  const timing = match[2].replace(/,\s*$/, '').trim();
  return { title: title || cleaned, timing: timing || null };
}

/**
 * PDF layout often shreds wrapped activity rows across pipe and plain lines, e.g.
 *   Advanced Lab Assignments (Algorithm Weeks 3, 5, 20%
 *   2.
 *   | Implementation) | 9, 11 |
 * Merge those fragments so Lab/Project weights are not lost.
 */
function parseAssessmentRowsFromSectionLines(lines: string[]): AssessmentActivityRow[] {
  type Draft = {
    titleParts: string[];
    timingParts: string[];
    percentage: number | null;
  };
  const rows: AssessmentActivityRow[] = [];
  let draft: Draft | null = null;

  const commit = () => {
    if (!draft) return;
    let title = draft.titleParts.join(' ').replace(/\s+/g, ' ').trim();
    let timing =
      draft.timingParts
        .join(', ')
        .replace(/\s+/g, ' ')
        .replace(/,\s*,+/g, ',')
        .replace(/\s+,/g, ',')
        .replace(/,\s*$/g, '')
        .trim() || null;
    if (!timing) {
      const peeled = peelTrailingTiming(title);
      title = peeled.title;
      timing = peeled.timing;
    }
    title = title
      .replace(/\s*---\s*Page\b.*$/i, '')
      .replace(/\s+/g, ' ')
      .replace(/\(\s+/g, '(')
      .replace(/\s+\)/g, ')')
      .trim();
    if (
      title &&
      !isPlaceholderValue(title) &&
      !TOTAL_LABEL.test(title) &&
      !ASSESSMENT_FOOTNOTE.test(title)
    ) {
      rows.push({
        title,
        timing,
        percentage: draft.percentage,
      });
    }
    draft = null;
  };

  const startDraft = (title: string, timing: string | null, percentage: number | null) => {
    commit();
    const peeled = timing ? { title, timing } : peelTrailingTiming(title);
    draft = {
      titleParts: peeled.title ? [peeled.title] : [],
      timingParts: peeled.timing ? [peeled.timing] : timing ? [timing] : [],
      percentage,
    };
  };

  const appendFragment = (raw: string) => {
    const text = raw.replace(/\s+/g, ' ').trim();
    if (!text || !draft) return;
    if (NUMBERING_CELL.test(text)) return;
    if (isPercentWeightCell(text)) {
      draft.percentage = draft.percentage ?? Math.round(firstNumber(text)!);
      return;
    }
    if (isTimingCell(text) || /^\d+(?:\s*,\s*\d+)+$/.test(text)) {
      // "9, 11" continuation of "Weeks 3, 5"
      if (draft.timingParts.length > 0 && /^\d/.test(text)) {
        draft.timingParts[draft.timingParts.length - 1] = `${draft.timingParts[draft.timingParts.length - 1]}, ${text}`;
      } else if (!draft.timingParts.includes(text)) {
        draft.timingParts.push(text);
      }
      return;
    }
    const peeled = peelTrailingTiming(text);
    if (peeled.timing && !draft.timingParts.length) draft.timingParts.push(peeled.timing);
    if (peeled.title) draft.titleParts.push(peeled.title);
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    // PDF page markers / footer page numbers — never part of an activity.
    if (/^---\s*Page\b/i.test(line) || /^\d{1,3}$/.test(line)) {
      commit();
      continue;
    }

    // Lone row number sitting on its own baseline (common in this PDF).
    if (/^\d+\s*[.)]?$/.test(line)) continue;

    if (line.startsWith('|')) {
      const cells = splitCells(line).map((cell) =>
        cell.replace(/\s*<br>\s*/g, ' ').replace(/\s+/g, ' ').trim(),
      );
      if (cells.every((cell) => !cell)) continue;
      if (isAssessmentHeaderLine(line, cells)) continue;

      const titleIndex = firstTextCellIndex(cells);
      if (titleIndex < 0) continue;
      const titleCell = cells[titleIndex];
      if (TOTAL_LABEL.test(titleCell)) {
        commit();
        continue;
      }
      if (ASSESSMENT_FOOTNOTE.test(titleCell) || /^\*/.test(titleCell)) continue;

      const hasNumbering = cells
        .slice(0, Math.max(titleIndex, 0) + 1)
        .some((cell) => NUMBERING_CELL.test(cell.trim()));
      const percentage = parseAssessmentPercentageCell(cells, titleIndex);
      const timingFromRow =
        cells.length >= titleIndex + 3 && !isPercentWeightCell(cells[titleIndex + 1] ?? '')
          ? cells[titleIndex + 1]
          : null;

      // Well-formed row: "| 1. | Mid-Term Exam | Week 7 | 20% |" — commit immediately.
      if (hasNumbering && percentage != null && cells.length >= titleIndex + 3) {
        startDraft(titleCell, timingFromRow, percentage);
        commit();
        continue;
      }

      // Numbered but incomplete (title only) — wait for wrap fragments.
      if (hasNumbering) {
        startDraft(titleCell, timingFromRow, percentage);
        for (const cell of cells.slice(titleIndex + 1)) appendFragment(cell);
        continue;
      }

      // Unnumbered pipe row with a % — often a wrapped project/lab line.
      if (percentage != null) {
        startDraft(titleCell, timingFromRow, percentage);
        for (const cell of cells.slice(titleIndex + 1)) {
          if (cell === timingFromRow) continue;
          if (isPercentWeightCell(cell)) continue;
          appendFragment(cell);
        }
        continue;
      }

      // Continuation fragments: "| Implementation) | 9, 11 |"
      if (draft) {
        for (const cell of cells) appendFragment(cell);
      }
      continue;
    }

    // Plain (non-pipe) lines — PDF often dumps wrapped lab/project rows here.
    if (ASSESSMENT_FOOTNOTE.test(line) || /^\*/.test(line)) {
      commit();
      continue;
    }
    if (TOTAL_LABEL.test(line)) {
      commit();
      continue;
    }
    if (/assessment\s+activities|percentage of total|assessment timing/i.test(line)) continue;

    const plainPercent = firstNumber(line.match(/(\d+(?:\.\d+)?)\s*%/)?.[0] ?? '');
    if (plainPercent != null && plainPercent >= 0 && plainPercent <= 100) {
      // e.g. "Advanced Lab Assignments (Algorithm Weeks 3, 5, 20%"
      const withoutPercent = line.replace(/\s*\d+(?:\.\d+)?\s*%\s*$/, '').trim();
      const peeled = peelTrailingTiming(withoutPercent);
      startDraft(peeled.title, peeled.timing, Math.round(plainPercent));
      continue;
    }

    if (draft) appendFragment(line);
  }
  commit();

  return rows.filter((row) => row.title && row.percentage != null);
}

/**
 * Rows of the Students Assessment Activities table as { title, timing, percentage }.
 * Timing is the cell after the activity; the percentage is the weight cell (usually last).
 */
export function findAssessmentActivityRows(text: string): AssessmentActivityRow[] {
  let best: AssessmentActivityRow[] = [];
  let bestScore = -1;
  for (const body of sectionTableLines(text, ASSESSMENT_ACTIVITIES_HEADING, NEXT_SECTION_AFTER_ASSESSMENTS)) {
    const rows = parseAssessmentRowsFromSectionLines(body);
    if (rows.length === 0) continue;
    const sum = rows.reduce((total, row) => total + (row.percentage ?? 0), 0);
    // Prefer a complete 100% plan, then the densest / highest-weight parse.
    const score = (sum === 100 ? 10_000 : 0) + sum * 10 + rows.length;
    if (score > bestScore) {
      best = rows;
      bestScore = score;
    }
    if (sum === 100) return rows;
  }
  return best;
}

/** Type label taken from the assessment activity name (dynamic, not a fixed enum). */
export function inferAssessmentType(title: string): string {
  const cleaned = String(title || '')
    .trim()
    .replace(/\s+/g, ' ');
  // Prefer the lead phrase before a long parenthetical (e.g. "Advanced Lab Assignments (...)").
  const withoutParen = cleaned.replace(/\s*\([^)]*\)\s*$/, '').trim();
  return withoutParen || cleaned || 'Assessment';
}

const toAssessmentPercentage = (value: unknown): number | null => {
  if (value == null || value === '') return null;
  const cleaned = String(value).replace(/%/g, '').trim();
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return null;
  return Math.round(parsed);
};

/**
 * Course specs always allocate 100% across activities. Snap near-100 float sums
 * to exact integers; leave clearly incomplete extractions untouched for review.
 */
export function normalizeAssessmentPlanPercentages(
  assessments: unknown,
  documentTotal: number | null = null,
): { assessments: Record<string, unknown>[]; assessmentsTotalPercentage: number | null; sum: number } {
  const rows = (Array.isArray(assessments) ? assessments : [])
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .filter((item) => !TOTAL_LABEL.test(primitiveText(item.title).trim()))
    .filter((item) => !ASSESSMENT_FOOTNOTE.test(primitiveText(item.title).trim()));

  const withPercents = rows.map((row) => ({
    ...row,
    percentage: toAssessmentPercentage(row.percentage ?? row.score ?? row.weight),
  }));

  const weighted = withPercents.filter((row) => row.percentage != null) as Array<
    Record<string, unknown> & { percentage: number }
  >;
  const sum = weighted.reduce((total, row) => total + row.percentage, 0);
  const target =
    documentTotal != null && documentTotal > 0 && documentTotal <= 100
      ? Math.round(documentTotal)
      : 100;

  // All rows have weights and already total the expected plan — keep as-is.
  if (
    weighted.length === withPercents.length &&
    withPercents.length > 0 &&
    sum === target
  ) {
    return {
      assessments: withPercents,
      assessmentsTotalPercentage: target,
      sum,
    };
  }

  // Float / rounding drift (e.g. 33.3+33.3+33.4) → largest-remainder to target.
  if (
    weighted.length === withPercents.length &&
    withPercents.length > 0 &&
    Math.abs(sum - target) <= 1.5 &&
    sum > 0
  ) {
    const raw = weighted.map((row) => (row.percentage / sum) * target);
    const floors = raw.map((value) => Math.floor(value + 1e-9));
    let remaining = target - floors.reduce((total, value) => total + value, 0);
    const order = raw
      .map((value, index) => ({ index, frac: value - Math.floor(value + 1e-9) }))
      .sort((a, b) => b.frac - a.frac || a.index - b.index);
    for (let i = 0; i < remaining; i += 1) {
      floors[order[i % order.length].index] += 1;
    }
    const normalized = withPercents.map((row, index) => ({
      ...row,
      percentage: floors[index],
    }));
    return {
      assessments: normalized,
      assessmentsTotalPercentage: target,
      sum: target,
    };
  }

  return {
    assessments: withPercents,
    assessmentsTotalPercentage:
      sum > 0 && weighted.length === withPercents.length ? Math.round(sum) : documentTotal,
    sum,
  };
}

const toAssessmentRecord = (row: {
  title: string;
  timing: string | null;
  percentage: number | null;
  type?: string;
}): Record<string, unknown> => ({
  title: row.title,
  type: row.type || inferAssessmentType(row.title),
  percentage: row.percentage,
  timing: row.timing,
  duration: null,
  totalMarks: null,
  passMark: null,
  numberOfVersions: 2,
  difficulty: 'BALANCED',
});

const assessmentTitleKey = (title: unknown) =>
  normalizeTitle(title).replace(/\b(?:exam|assignment|assignments|project|quiz|quizzes)\b/g, (m) =>
    m.toLowerCase(),
  );

/** Document rows win when complete; otherwise merge with AI so wrapped PDF rows are not lost. */
function applyAssessmentFallbacks(assessments: unknown, text: string): unknown {
  const documentRows = text ? findAssessmentActivityRows(text) : [];
  const aiRows = (Array.isArray(assessments) ? assessments : [])
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .filter((item) => !TOTAL_LABEL.test(primitiveText(item.title).trim()))
    .filter((item) => !ASSESSMENT_FOOTNOTE.test(primitiveText(item.title).trim()))
    .map((item) => ({
      ...item,
      title: primitiveText(item.title || item.activity).trim(),
      percentage: toAssessmentPercentage(item.percentage ?? item.score ?? item.weight),
      timing: toCleanText(item.timing),
      type: primitiveText(item.type).trim() || inferAssessmentType(primitiveText(item.title)),
    }))
    .filter((item) => item.title);

  const documentMapped = documentRows.map((row) => toAssessmentRecord(row));
  const documentSum = documentRows.reduce((total, row) => total + (row.percentage ?? 0), 0);

  if (documentMapped.length > 0 && documentSum >= 100) {
    return documentMapped;
  }

  if (documentMapped.length > 0 && aiRows.length > 0) {
    const merged = [...documentMapped];
    const seen = new Set(merged.map((row) => assessmentTitleKey(row.title)));
    for (const ai of aiRows) {
      const key = assessmentTitleKey(ai.title);
      if (!key || seen.has(key)) continue;
      // Fuzzy: AI title contained in a document title (or vice versa) counts as same row.
      const overlap = [...seen].some(
        (existing) => existing.includes(key) || key.includes(existing),
      );
      if (overlap) continue;
      seen.add(key);
      merged.push(
        toAssessmentRecord({
          title: String(ai.title),
          timing: (ai.timing as string | null) ?? null,
          percentage: (ai.percentage as number | null) ?? null,
          type: String(ai.type || ''),
        }),
      );
    }
    const mergedSum = merged.reduce(
      (total, row) => total + (typeof row.percentage === 'number' ? row.percentage : 0),
      0,
    );
    // Prefer the fuller plan when document parse was incomplete (common with wrapped PDF cells).
    if (mergedSum > documentSum || merged.length > documentMapped.length) {
      return merged;
    }
    return documentMapped;
  }

  if (documentMapped.length > 0) return documentMapped;
  return aiRows;
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

  // Assessment activity tables are usually single-line cells; parse them from
  // DOCX and layout-PDF pipe text (not only when `exact` is true for other fields).
  const documentAssessmentTotal =
    (text ? findAssessmentActivitiesTotal(text) : null) ??
    toPositiveInt(result.assessmentsTotalPercentage);
  const assessmentRows = applyAssessmentFallbacks(result.assessments, text);
  const normalizedAssessments = normalizeAssessmentPlanPercentages(
    assessmentRows,
    documentAssessmentTotal,
  );
  next.assessments = normalizedAssessments.assessments;
  next.assessmentsTotalPercentage =
    normalizedAssessments.assessmentsTotalPercentage ?? documentAssessmentTotal;

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
