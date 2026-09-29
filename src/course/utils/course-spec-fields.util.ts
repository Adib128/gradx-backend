export const COURSE_TYPE_SCOPES = [
  'UNIVERSITY',
  'COLLEGE',
  'DEPARTMENT',
  'TRACK',
  'OTHERS',
] as const;
export type CourseTypeScope = (typeof COURSE_TYPE_SCOPES)[number];

export const COURSE_REQUIREMENTS = ['REQUIRED', 'ELECTIVE'] as const;
export type CourseRequirement = (typeof COURSE_REQUIREMENTS)[number];

export const COURSE_SPEC_TEXT_FIELDS = [
  'department',
  'college',
  'institution',
  'version',
  'lastRevisionDate',
  'creditHoursDetail',
  'courseTypeOther',
  'otherContactHoursLabel',
  'approvalCouncil',
  'approvalReferenceNo',
  'approvalDate',
] as const;

export const COURSE_SPEC_HOUR_FIELDS = [
  'fieldHours',
  'tutorialHours',
  'otherContactHours',
] as const;

type CourseSpecTextField = (typeof COURSE_SPEC_TEXT_FIELDS)[number];
type CourseSpecHourField = (typeof COURSE_SPEC_HOUR_FIELDS)[number];

/** One row of the "Assessment of Course Quality" table. */
export type CourseQualityAssessmentRow = {
  area: string;
  assessor: string | null;
  methods: string | null;
};

export type CourseSpecFields = Partial<
  Record<CourseSpecTextField, string | null> &
    Record<CourseSpecHourField, number | null> & {
      courseTypeScope: CourseTypeScope | null;
      courseRequirement: CourseRequirement | null;
      courseQualityAssessment: CourseQualityAssessmentRow[];
    }
>;

/** Stringifies primitives only; objects/arrays become ''. */
export const primitiveText = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
      ? String(value)
      : '';

/** undefined stays undefined (field untouched); blank → null; otherwise trimmed single-spaced text. */
export const normalizeOptionalText = (value: unknown) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = primitiveText(value).replace(/\s+/g, ' ').trim();
  return text || null;
};

export const normalizeOptionalHours = (value: unknown) => {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const parsed = Number(primitiveText(value).replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed);
};

export const normalizeCourseTypeScope = (
  value: unknown,
): CourseTypeScope | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const raw = primitiveText(value).trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if ((COURSE_TYPE_SCOPES as readonly string[]).includes(upper)) {
    return upper as CourseTypeScope;
  }
  const lower = raw.toLowerCase();
  if (lower.includes('universit') || raw.includes('جامع')) return 'UNIVERSITY';
  if (lower.includes('college') || raw.includes('كلي')) return 'COLLEGE';
  if (lower.includes('department') || raw.includes('قسم')) return 'DEPARTMENT';
  if (lower.includes('track') || raw.includes('مسار')) return 'TRACK';
  if (lower.includes('other') || raw.includes('أخرى') || raw.includes('اخرى')) {
    return 'OTHERS';
  }
  return null;
};

export const normalizeCourseRequirement = (
  value: unknown,
): CourseRequirement | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const raw = primitiveText(value).trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (
    lower.includes('elective') ||
    lower.includes('optional') ||
    raw.includes('اختيار')
  ) {
    return 'ELECTIVE';
  }
  if (
    lower.includes('required') ||
    lower.includes('compulsory') ||
    lower.includes('mandatory') ||
    lower.includes('core') ||
    raw.includes('إجبار') ||
    raw.includes('اجبار') ||
    raw.includes('إلزام')
  ) {
    return 'REQUIRED';
  }
  return null;
};

const multilineText = (value: unknown): string | null => {
  const text = primitiveText(value)
    .split(/\s*<br\s*\/?>\s*|\r?\n/i)
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return text || null;
};

/** Facility rows with `<br>` turned into line breaks; rows with no item and no resources are dropped. */
export function normalizeFacilityRows(value: unknown): Array<{ item: string; resources: string }> {
  if (!Array.isArray(value)) return [];
  const rows: Array<{ item: string; resources: string }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const item = multilineText(row.item) ?? '';
    const resources = multilineText(row.resources) ?? '';
    if (item || resources) rows.push({ item, resources });
  }
  return rows;
}

/**
 * Quality-assessment rows with blank cells trimmed to null; empty rows are dropped.
 * `requireAssessment` also drops rows with no assessor and no methods (unfilled template rows).
 * undefined stays undefined so partial updates leave the column untouched.
 */
export function normalizeCourseQualityAssessment(
  value: unknown,
  requireAssessment = false,
): CourseQualityAssessmentRow[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return [];
  const rows: CourseQualityAssessmentRow[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const area = multilineText(row.area ?? row.assessmentArea ?? row.issue) ?? '';
    const assessor = multilineText(row.assessor ?? row.assessors);
    const methods = multilineText(row.methods ?? row.assessmentMethods ?? row.method);
    if (!assessor && !methods && (requireAssessment || !area)) continue;
    rows.push({ area, assessor, methods });
  }
  return rows;
}

const planTitleKey = (value: unknown) =>
  primitiveText(value).replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Normalizes plan items' `timing` and keeps the stored timing (matched by title)
 * for items that arrive without one — the syllabus builder does not edit timing.
 */
export function mergeAssessmentPlanTiming(
  incoming: unknown[],
  existing: unknown,
): unknown[] {
  const storedTiming = new Map<string, string>();
  if (Array.isArray(existing)) {
    for (const item of existing) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const timing = normalizeOptionalText(row.timing);
      if (timing) storedTiming.set(planTitleKey(row.title), timing);
    }
  }

  return incoming.map((item) => {
    if (!item || typeof item !== 'object') return item;
    const row = item as Record<string, unknown>;
    const timing =
      normalizeOptionalText(row.timing) ?? storedTiming.get(planTitleKey(row.title)) ?? null;
    return { ...row, timing };
  });
}

/**
 * Picks and normalizes the course-specification fields present in `body`.
 * Keys absent from `body` are omitted so partial updates leave them untouched.
 */
export function pickCourseSpecFields(
  body: object | null | undefined,
): CourseSpecFields {
  const source = (body ?? {}) as Record<string, unknown>;
  const result: CourseSpecFields = {};

  for (const key of COURSE_SPEC_TEXT_FIELDS) {
    const value = normalizeOptionalText(source[key]);
    if (value !== undefined) result[key] = value;
  }
  for (const key of COURSE_SPEC_HOUR_FIELDS) {
    const value = normalizeOptionalHours(source[key]);
    if (value !== undefined) result[key] = value;
  }

  const scope = normalizeCourseTypeScope(source.courseTypeScope);
  if (scope !== undefined) result.courseTypeScope = scope;
  const requirement = normalizeCourseRequirement(source.courseRequirement);
  if (requirement !== undefined) result.courseRequirement = requirement;
  const quality = normalizeCourseQualityAssessment(source.courseQualityAssessment);
  if (quality !== undefined) result.courseQualityAssessment = quality;

  if (result.courseTypeScope && result.courseTypeScope !== 'OTHERS') {
    if ('courseTypeScope' in source) result.courseTypeOther = null;
  }

  return result;
}
