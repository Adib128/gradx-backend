import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { Prisma } from 'generated/prisma/client';
import { orderQuestionsForSheet } from 'src/grading/answer-sheet-layout';
import {
  WORKBOOK_SOURCE,
  WorkbookQuestionType,
  normalizeQuestionType,
  parseCourseWorkbook,
  ParsedAssessmentSheet,
  ParsedCourseWorkbook,
  ParsedMark,
} from './utils/course-workbook.util';

type WorkbookUser = { userId: number; tenantId: number };

type StudentAction = 'create' | 'existing' | 'update' | 'enroll' | 'other-course';
type QuestionAction = 'create' | 'update' | 'keep';

export type WorkbookPreviewStudent = {
  studentId: string;
  name: string;
  section: string;
  departement: string;
  action: StudentAction;
  sheets: string[];
};

export type WorkbookPreviewQuestion = {
  number: number;
  column: string;
  label: string;
  questionId: number | null;
  cloCodes: string[];
  maxMarks: number;
  type: WorkbookQuestionType;
  text: string;
  action: QuestionAction;
  averagePercent: number | null;
};

export type WorkbookPreviewRow = {
  rowNumber: number;
  studentId: string;
  name: string;
  marks: Array<number | null>;
  total: number;
  percent: number;
  studentAction: StudentAction;
};

export type WorkbookPreviewAssessment = {
  sheetName: string;
  action: 'create' | 'update' | 'skip';
  assessmentId: number | null;
  code: string | null;
  type: string;
  title: string;
  weight: number | null;
  totalMarks: number;
  passMark: number;
  questions: WorkbookPreviewQuestion[];
  rows: WorkbookPreviewRow[];
  untouchedQuestions: number;
  stats: {
    graded: number;
    averagePercent: number | null;
    highestPercent: number | null;
    lowestPercent: number | null;
    passed: number;
    passRatePercent: number | null;
  };
  cloMarks: Array<{ code: string; marks: number; averagePercent: number | null }>;
  errors: string[];
  warnings: string[];
};

export type WorkbookPreview = {
  canImport: boolean;
  errors: string[];
  warnings: string[];
  course: {
    id: number;
    title: string;
    code: string | null;
    passRate: number;
    assessmentPassRate: number;
  };
  summary: {
    assessmentsToCreate: number;
    assessmentsToUpdate: number;
    questionsToCreate: number;
    questionsToUpdate: number;
    studentsToCreate: number;
    studentsToUpdate: number;
    gradesToSave: number;
  };
  students: WorkbookPreviewStudent[];
  assessments: WorkbookPreviewAssessment[];
};

type CourseForWorkbook = Awaited<ReturnType<CourseWorkbookService['loadCourse']>>;

type PlannedQuestion = WorkbookPreviewQuestion & { cloIds: number[] };

type PlannedAssessment = WorkbookPreviewAssessment & {
  plannedQuestions: PlannedQuestion[];
  plannedRows: Array<WorkbookPreviewRow & { rawMarks: Array<number | null> }>;
};

type Analysis = {
  preview: WorkbookPreview;
  course: CourseForWorkbook;
  students: Map<string, WorkbookPreviewStudent & { existingId: number | null }>;
  assessments: PlannedAssessment[];
};

const round1 = (value: number) => Math.round(value * 10) / 10;
const round2 = (value: number) => Math.round(value * 100) / 100;
const codeKey = (value: string) => value.trim().toLowerCase();

function planItemType(item: Record<string, unknown>) {
  const raw = item?.type || item?.title;
  return typeof raw === 'string' ? raw.trim() : '';
}

/** In-app marks editor payload (mirrors ParsedCourseWorkbook without Excel). */
export type EditorWorkbookPayload = {
  students: Array<{
    studentId: string;
    name: string;
    section?: string;
    departement?: string;
  }>;
  assessments: Array<{
    sheetName: string;
    code?: string | null;
    type: string;
    title: string;
    weight?: number | null;
    questions: Array<{
      questionId?: number | null;
      label?: string;
      cloCodes: string[];
      maxMarks: number | null;
      type: string;
      text?: string;
    }>;
    rows: Array<{
      studentId: string;
      name?: string;
      section?: string;
      departement?: string;
      marks: Array<number | null>;
    }>;
  }>;
};

function columnLetter(index: number) {
  let n = index + 1;
  let label = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label || 'A';
}

function editorPayloadToParsed(payload: EditorWorkbookPayload): ParsedCourseWorkbook {
  const roster = (payload.students ?? [])
    .map((student, index) => ({
      sheetName: 'Students',
      rowNumber: index + 1,
      studentId: String(student.studentId ?? '').trim(),
      name: String(student.name ?? '').trim(),
      section: String(student.section ?? '').trim(),
      departement: String(student.departement ?? '').trim(),
    }))
    .filter((row) => row.studentId);

  const assessments: ParsedAssessmentSheet[] = (payload.assessments ?? []).map(
    (sheet, sheetIndex) => {
      const questions = (sheet.questions ?? []).map((question, index) => {
        const questionId =
          question.questionId != null && Number.isInteger(Number(question.questionId))
            ? Number(question.questionId)
            : null;
        const maxParsed =
          question.maxMarks == null || !Number.isFinite(Number(question.maxMarks))
            ? null
            : Number(question.maxMarks);
        return {
          column: columnLetter(index + 4),
          label: String(question.label ?? `Q${index + 1}`).trim() || `Q${index + 1}`,
          questionId,
          questionIdRaw: questionId != null ? String(questionId) : '',
          cloCodes: Array.isArray(question.cloCodes)
            ? question.cloCodes.map((code) => String(code).trim()).filter(Boolean)
            : [],
          maxMarks: maxParsed,
          maxMarksRaw: maxParsed == null ? '' : String(maxParsed),
          typeRaw: String(question.type ?? '').trim(),
          text: String(question.text ?? '').trim(),
        };
      });

      const rows = (sheet.rows ?? [])
        .map((row, index) => {
          const marks: ParsedMark[] = questions.map((_, qIndex) => {
            const value = row.marks?.[qIndex];
            if (value == null) return null;
            const num = Number(value);
            return Number.isFinite(num) ? num : { invalid: String(value) };
          });
          return {
            rowNumber: index + 1,
            studentId: String(row.studentId ?? '').trim(),
            name: String(row.name ?? '').trim(),
            section: String(row.section ?? '').trim(),
            departement: String(row.departement ?? '').trim(),
            marks,
          };
        })
        .filter((row) => row.studentId || row.marks.some((mark) => mark !== null));

      return {
        sheetName: String(sheet.sheetName || sheet.title || `Assessment ${sheetIndex + 1}`).trim(),
        code: String(sheet.code ?? '').trim(),
        type: String(sheet.type ?? '').trim(),
        title: String(sheet.title ?? '').trim(),
        weightRaw:
          sheet.weight == null || !Number.isFinite(Number(sheet.weight))
            ? ''
            : String(sheet.weight),
        questions,
        rows,
        errors: [],
      };
    },
  );

  return { roster, assessments };
}

function omit<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
}

/** Flat text for workbook cells — avoids `[object Object]` from bad/legacy values. */
function workbookFieldText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '[object Object]' ? '' : trimmed;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of ['name', 'code', 'title', 'label', 'value', 'section', 'departement', 'department']) {
      const nested = obj[key];
      if (typeof nested === 'string' || typeof nested === 'number') {
        const text = String(nested).trim();
        return text === '[object Object]' ? '' : text;
      }
    }
    return '';
  }
  const fallback = String(value).trim();
  return fallback === '[object Object]' ? '' : fallback;
}

@Injectable()
export class CourseWorkbookService {
  constructor(private readonly prisma: PrismaService) {}

  private async loadCourse(tenantId: number, courseId: number) {
    const course = await this.prisma.course.findFirst({
      where: { id: courseId, tenantId, deletedAt: null },
      select: {
        id: true,
        title: true,
        code: true,
        academicYear: true,
        semester: true,
        passRate: true,
        assessmentPassRate: true,
        assessmentPlan: true,
        clos: {
          select: { id: true, code: true, description: true },
          orderBy: { id: 'asc' },
        },
        topics: {
          select: { id: true, topicNumber: true, topicClos: { select: { cloId: true } } },
          orderBy: { topicNumber: 'asc' },
        },
        students: {
          select: { id: true, studentId: true, name: true, section: true, departement: true },
          orderBy: { studentId: 'asc' },
        },
        assessments: {
          select: {
            id: true,
            code: true,
            type: true,
            title: true,
            percentage: true,
            totalMarks: true,
            createdAt: true,
            questions: {
              orderBy: { id: 'asc' },
              select: {
                id: true,
                type: true,
                text: true,
                points: true,
                questionClos: { select: { cloId: true } },
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!course) throw new NotFoundException('Course not found.');
    return course;
  }

  private assessmentTypes(course: CourseForWorkbook) {
    const plan = Array.isArray(course.assessmentPlan)
      ? (course.assessmentPlan as Array<Record<string, unknown>>)
      : [];
    const fromPlan = plan.map(planItemType);
    const fromAssessments = course.assessments.map((assessment) => assessment.type.trim());
    return Array.from(new Set([...fromPlan, ...fromAssessments].filter(Boolean)));
  }

  /** Everything the frontend needs to build the course marks template. */
  async getContext(tenantId: number, courseId: number) {
    const course = await this.loadCourse(tenantId, courseId);
    const cloCodeById = new Map(course.clos.map((clo) => [clo.id, clo.code]));
    const plan = Array.isArray(course.assessmentPlan)
      ? (course.assessmentPlan as Array<Record<string, unknown>>)
          .map((item) => ({
            type: planItemType(item),
            percentage: Number.isFinite(Number(item?.percentage)) ? Number(item.percentage) : null,
          }))
          .filter((item) => item.type)
      : [];

    const assessmentIds = course.assessments.map((assessment) => assessment.id);
    const scans = assessmentIds.length
      ? await this.prisma.gradingScan.findMany({
          where: {
            tenantId,
            assessmentId: { in: assessmentIds },
            status: 'COMPLETED',
            confirmedAt: { not: null },
          },
          select: {
            assessmentId: true,
            studentId: true,
            matchedStudentCode: true,
            detectedStudentId: true,
            questionDetails: true,
          },
          orderBy: [{ confirmedAt: 'desc' }, { id: 'desc' }],
        })
      : [];

    const studentCodeById = new Map(course.students.map((student) => [student.id, student.studentId]));
    const resultsByAssessment = new Map<number, Map<string, Record<number, number>>>();
    const gradedByAssessment = new Map<number, number>();
    for (const scan of scans) {
      if (scan.assessmentId == null) continue;
      const code =
        (scan.studentId != null ? studentCodeById.get(scan.studentId) : undefined) ??
        (scan.matchedStudentCode || scan.detectedStudentId || '').trim();
      if (!code) continue;
      const byStudent = resultsByAssessment.get(scan.assessmentId) ?? new Map();
      if (byStudent.has(code)) continue;
      const marks: Record<number, number> = {};
      if (Array.isArray(scan.questionDetails)) {
        for (const detail of scan.questionDetails as Array<Record<string, unknown>>) {
          const questionId = Number(detail?.questionId);
          const earned = Number(detail?.earnedPoints);
          if (Number.isInteger(questionId) && Number.isFinite(earned)) marks[questionId] = earned;
        }
      }
      byStudent.set(code, marks);
      resultsByAssessment.set(scan.assessmentId, byStudent);
      gradedByAssessment.set(scan.assessmentId, (gradedByAssessment.get(scan.assessmentId) ?? 0) + 1);
    }

    return {
      course: {
        id: course.id,
        title: course.title,
        code: course.code,
        academicYear: course.academicYear,
        semester: course.semester,
        passRate: course.passRate,
        assessmentPassRate: course.assessmentPassRate,
      },
      assessmentTypes: this.assessmentTypes(course),
      plan,
      clos: course.clos.map((clo) => ({ code: clo.code, description: clo.description })),
      students: course.students.map((student) => ({
        studentId: String(student.studentId ?? '').trim(),
        name: String(student.name ?? '').trim(),
        section: workbookFieldText(student.section),
        departement: workbookFieldText(student.departement),
      })),
      assessments: course.assessments.map((assessment) => {
        const ordered = orderQuestionsForSheet(assessment.questions);
        const byStudent = resultsByAssessment.get(assessment.id) ?? new Map();
        return {
          id: assessment.id,
          code: assessment.code,
          type: assessment.type,
          title: assessment.title,
          percentage: assessment.percentage,
          totalMarks: assessment.totalMarks,
          gradedCount: gradedByAssessment.get(assessment.id) ?? 0,
          questions: ordered.map((question, index) => ({
            id: question.id,
            number: index + 1,
            type: question.type,
            text: question.text,
            points: question.points,
            cloCodes: question.questionClos
              .map((link) => cloCodeById.get(link.cloId))
              .filter((code): code is string => Boolean(code)),
          })),
          results: Array.from(byStudent.entries())
            .filter(([, marks]) => Object.keys(marks).length > 0)
            .map(([studentId, marks]) => ({ studentId, marks })),
        };
      }),
    };
  }

  async preview(user: WorkbookUser, courseId: number, file?: Express.Multer.File) {
    const analysis = await this.analyzeFile(user, courseId, file);
    return analysis.preview;
  }

  /** Persist an in-app marks editor payload (same rules as Excel import). */
  async saveEditor(user: WorkbookUser, courseId: number, payload: EditorWorkbookPayload) {
    const parsed = editorPayloadToParsed(payload);
    const analysis = await this.analyzeParsed(user, courseId, parsed);
    return this.persistAnalysis(user, analysis);
  }

  private async analyzeFile(
    user: WorkbookUser,
    courseId: number,
    file?: Express.Multer.File,
  ): Promise<Analysis> {
    if (!file?.buffer?.length) throw new BadRequestException('Excel file is required.');
    if (file.buffer.length > 10 * 1024 * 1024) {
      throw new BadRequestException('The Excel file is too large (max 10 MB).');
    }

    let parsed: ReturnType<typeof parseCourseWorkbook>;
    try {
      parsed = parseCourseWorkbook(file.buffer);
    } catch {
      throw new BadRequestException('Could not read the Excel file.');
    }
    return this.analyzeParsed(user, courseId, parsed);
  }

  private async analyzeParsed(
    user: WorkbookUser,
    courseId: number,
    parsed: ParsedCourseWorkbook,
  ): Promise<Analysis> {
    const course = await this.loadCourse(user.tenantId, courseId);
    const passRate = course.assessmentPassRate;
    const errors: string[] = [];
    const warnings: string[] = [];

    if (parsed.assessments.length === 0) {
      errors.push('No assessment tabs were found. Add at least one assessment tab.');
    }

    const cloByCode = new Map(course.clos.map((clo) => [codeKey(clo.code), clo]));
    const assessmentByCode = new Map(
      course.assessments.map((assessment) => [codeKey(assessment.code), assessment]),
    );
    const courseTypes = new Set(this.assessmentTypes(course).map(codeKey));

    // ---- Students (roster tab first, then names typed on assessment tabs) ----
    const students = new Map<string, WorkbookPreviewStudent & { existingId: number | null }>();
    const mergeStudent = (
      sheet: string,
      raw: { studentId: string; name: string; section: string; departement: string },
    ) => {
      const key = raw.studentId.trim();
      if (!key) return;
      const current = students.get(key);
      if (!current) {
        students.set(key, {
          studentId: key,
          name: raw.name,
          section: raw.section,
          departement: raw.departement,
          action: 'existing',
          sheets: [sheet],
          existingId: null,
        });
        return;
      }
      if (!current.sheets.includes(sheet)) current.sheets.push(sheet);
      if (!current.name && raw.name) current.name = raw.name;
      if (!current.section && raw.section) current.section = raw.section;
      if (!current.departement && raw.departement) current.departement = raw.departement;
    };
    const rosterSeen = new Set<string>();
    for (const row of parsed.roster) {
      if (rosterSeen.has(row.studentId)) {
        errors.push(`${row.sheetName} row ${row.rowNumber}: student ID ${row.studentId} is listed twice.`);
        continue;
      }
      rosterSeen.add(row.studentId);
      mergeStudent(row.sheetName, row);
    }
    for (const sheet of parsed.assessments) {
      for (const row of sheet.rows) mergeStudent(sheet.sheetName, row);
    }

    const rosterByCode = new Map(course.students.map((student) => [student.studentId, student]));
    const outsideCodes = Array.from(students.keys()).filter((code) => !rosterByCode.has(code));
    const outside = outsideCodes.length
      ? await this.prisma.student.findMany({
          where: { studentId: { in: outsideCodes } },
          select: { id: true, studentId: true, courseId: true, name: true },
        })
      : [];
    const outsideByCode = new Map(outside.map((student) => [student.studentId, student]));
    const differs = (next: string, current: string | null | undefined) =>
      Boolean(next) && next !== (current ?? '');

    for (const student of students.values()) {
      const enrolled = rosterByCode.get(student.studentId);
      if (enrolled) {
        student.existingId = enrolled.id;
        student.action =
          differs(student.name, enrolled.name) ||
          differs(student.section, enrolled.section) ||
          differs(student.departement, enrolled.departement)
            ? 'update'
            : 'existing';
        if (!student.name) student.name = enrolled.name;
        continue;
      }
      const elsewhere = outsideByCode.get(student.studentId);
      if (elsewhere) {
        student.existingId = elsewhere.id;
        if (!student.name) student.name = elsewhere.name;
        if (elsewhere.courseId != null && elsewhere.courseId !== course.id) {
          student.action = 'other-course';
          warnings.push(
            `Student ${student.studentId} is enrolled in another course; their marks are saved but will not appear in this course's reports.`,
          );
        } else {
          student.action = 'enroll';
        }
        continue;
      }
      if (!student.name) {
        errors.push(
          `Student ${student.studentId} is new: add the student name (Students tab or the assessment tab) so the student can be created.`,
        );
      }
      student.action = 'create';
    }

    // ---- Assessments ----
    const assessments: PlannedAssessment[] = [];
    const seenCodes = new Map<string, string>();
    for (const sheet of parsed.assessments) {
      const planned = this.planAssessment(sheet, {
        course,
        passRate,
        cloByCode,
        assessmentByCode,
        courseTypes,
        students,
      });
      if (planned.code && planned.action !== 'skip') {
        const key = codeKey(planned.code);
        const other = seenCodes.get(key);
        if (other) {
          planned.errors.push(`Assessment code ${planned.code} is also used on tab "${other}".`);
        } else {
          seenCodes.set(key, sheet.sheetName);
        }
      }
      assessments.push(planned);
    }

    for (const assessment of assessments) {
      for (const message of assessment.errors) errors.push(`${assessment.sheetName}: ${message}`);
    }

    const active = assessments.filter((assessment) => assessment.action !== 'skip');
    const summary = {
      assessmentsToCreate: active.filter((a) => a.action === 'create').length,
      assessmentsToUpdate: active.filter((a) => a.action === 'update').length,
      questionsToCreate: active.reduce(
        (sum, a) => sum + a.questions.filter((q) => q.action === 'create').length,
        0,
      ),
      questionsToUpdate: active.reduce(
        (sum, a) => sum + a.questions.filter((q) => q.action === 'update').length,
        0,
      ),
      studentsToCreate: Array.from(students.values()).filter((s) => s.action === 'create').length,
      studentsToUpdate: Array.from(students.values()).filter(
        (s) => s.action === 'update' || s.action === 'enroll',
      ).length,
      gradesToSave: active.reduce((sum, a) => sum + a.rows.length, 0),
    };

    const hasWork =
      active.length > 0 || summary.studentsToCreate > 0 || summary.studentsToUpdate > 0;
    if (!hasWork && errors.length === 0) {
      errors.push('Nothing to save: add assessments with questions, marks or students.');
    }

    const preview: WorkbookPreview = {
      canImport: errors.length === 0 && hasWork,
      errors,
      warnings,
      course: {
        id: course.id,
        title: course.title,
        code: course.code,
        passRate: course.passRate,
        assessmentPassRate: passRate,
      },
      summary,
      students: Array.from(students.values())
        .map((student) => omit(student, 'existingId'))
        .sort((a, b) => a.studentId.localeCompare(b.studentId)),
      assessments: assessments.map((assessment) =>
        omit(assessment, 'plannedQuestions', 'plannedRows'),
      ),
    };

    return { preview, course, students, assessments };
  }

  private planAssessment(
    sheet: ParsedAssessmentSheet,
    ctx: {
      course: CourseForWorkbook;
      passRate: number;
      cloByCode: Map<string, CourseForWorkbook['clos'][number]>;
      assessmentByCode: Map<string, CourseForWorkbook['assessments'][number]>;
      courseTypes: Set<string>;
      students: Map<string, WorkbookPreviewStudent>;
    },
  ): PlannedAssessment {
    const errors = [...sheet.errors];
    const warnings: string[] = [];
    const existing = sheet.code ? (ctx.assessmentByCode.get(codeKey(sheet.code)) ?? null) : null;
    if (sheet.code && !existing) {
      errors.push(
        `Assessment code ${sheet.code} does not belong to this course. Clear it to create a new assessment.`,
      );
    }

    const isActiveQuestion = (index: number) => {
      const question = sheet.questions[index];
      return (
        question.maxMarks != null ||
        question.cloCodes.length > 0 ||
        question.questionId != null ||
        sheet.rows.some((row) => row.marks[index] !== null)
      );
    };
    const activeIndexes = sheet.questions.map((_, index) => index).filter(isActiveQuestion);
    const hasMarks = sheet.rows.some((row) => row.marks.some((mark) => mark !== null));

    const base = {
      sheetName: sheet.sheetName,
      assessmentId: existing?.id ?? null,
      code: existing?.code ?? (sheet.code || null),
      type: sheet.type || existing?.type || '',
      title: sheet.title || existing?.title || sheet.sheetName,
      untouchedQuestions: 0,
      cloMarks: [] as PlannedAssessment['cloMarks'],
      stats: {
        graded: 0,
        averagePercent: null,
        highestPercent: null,
        lowestPercent: null,
        passed: 0,
        passRatePercent: null,
      },
    };

    if (!existing && !sheet.code && activeIndexes.length === 0 && !hasMarks) {
      return {
        ...base,
        action: 'skip',
        weight: null,
        totalMarks: 0,
        passMark: 0,
        questions: [],
        rows: [],
        errors: [],
        warnings: ['Empty tab — skipped.'],
        plannedQuestions: [],
        plannedRows: [],
      };
    }

    if (!sheet.type.trim()) {
      errors.push('Select the assessment type.');
    } else if (ctx.courseTypes.size > 0 && !ctx.courseTypes.has(codeKey(sheet.type))) {
      warnings.push(`Assessment type "${sheet.type}" is not in the course assessment plan.`);
    }
    if (!sheet.title.trim()) {
      warnings.push(`No assessment title — the tab name "${sheet.sheetName}" is used.`);
    }
    if (!existing) {
      const sameTitle = ctx.course.assessments.find(
        (assessment) =>
          codeKey(assessment.title) === codeKey(base.title) &&
          codeKey(assessment.type) === codeKey(base.type),
      );
      if (sameTitle) {
        warnings.push(
          `"${base.title}" already exists as ${sameTitle.code}. A new assessment will be created; put ${sameTitle.code} in "Assessment code" to update it instead.`,
        );
      }
    }

    let weight: number | null = null;
    if (sheet.weightRaw) {
      const parsed = Number(String(sheet.weightRaw).replace('%', '').replace(',', '.'));
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
        errors.push(`Weight "${sheet.weightRaw}" must be a number between 0 and 100.`);
      } else {
        weight = Math.round(parsed);
      }
    } else if (existing?.percentage != null) {
      weight = existing.percentage;
    }

    const existingQuestions = new Map(
      (existing?.questions ?? []).map((question) => [question.id, question]),
    );
    const usedQuestionIds = new Set<number>();
    const plannedQuestions: PlannedQuestion[] = [];

    activeIndexes.forEach((index, order) => {
      const question = sheet.questions[index];
      const where = `${question.label} (column ${question.column})`;
      const current =
        question.questionId != null ? existingQuestions.get(question.questionId) : undefined;

      if (question.questionId != null) {
        if (!current) {
          errors.push(
            `${where}: question ID ${question.questionId} is not part of this assessment. Clear the Question ID cell for new questions.`,
          );
        } else if (usedQuestionIds.has(question.questionId)) {
          errors.push(`${where}: question ID ${question.questionId} is used twice.`);
        }
        usedQuestionIds.add(question.questionId);
      } else if (question.questionIdRaw) {
        errors.push(`${where}: invalid question ID "${question.questionIdRaw}".`);
      }

      const maxMarks = question.maxMarks;
      if (maxMarks == null) {
        errors.push(`${where}: enter the max marks.`);
      } else if (!Number.isInteger(maxMarks) || maxMarks <= 0) {
        errors.push(`${where}: max marks must be a whole number above 0 (got ${question.maxMarksRaw}).`);
      }

      const cloIds: number[] = [];
      if (question.cloCodes.length === 0) {
        warnings.push(
          `${where}: no CLO selected — question is saved without CLO mapping until you set one.`,
        );
      }
      for (const code of question.cloCodes) {
        const clo = ctx.cloByCode.get(codeKey(code));
        if (clo) cloIds.push(clo.id);
        else errors.push(`${where}: CLO "${code}" is not a course CLO.`);
      }

      const type = normalizeQuestionType(question.typeRaw);
      if (!question.typeRaw.trim()) {
        errors.push(`${where}: select the question type.`);
      } else if (!type) {
        errors.push(
          `${where}: question type "${question.typeRaw}" must be MCQ, TRUE_FALSE, SHORT_ANSWER, Coding, ORDERING, or MATCHING.`,
        );
      }

      const text =
        question.text ||
        current?.text ||
        (question.cloCodes.length
          ? `${question.label} — CLO ${question.cloCodes.join(', ')}`
          : question.label);
      let action: QuestionAction = 'create';
      if (current) {
        const currentClos = current.questionClos.map((link) => link.cloId).sort().join(',');
        const nextClos = [...cloIds].sort().join(',');
        const changed =
          current.points !== maxMarks ||
          currentClos !== nextClos ||
          (type != null && current.type !== type) ||
          (Boolean(question.text) && question.text !== current.text);
        action = changed ? 'update' : 'keep';
      }

      plannedQuestions.push({
        number: order + 1,
        column: question.column,
        label: question.label,
        questionId: current?.id ?? null,
        cloCodes: question.cloCodes,
        cloIds: Array.from(new Set(cloIds)),
        maxMarks: maxMarks ?? 0,
        type: type ?? 'MCQ', // narrowed only after validation; empty type already errors above
        text,
        action,
        averagePercent: null,
      });
    });

    if (plannedQuestions.length === 0) {
      errors.push('Add at least one question with max marks.');
    }

    const untouched = (existing?.questions ?? []).filter((question) => !usedQuestionIds.has(question.id));
    if (untouched.length > 0) {
      warnings.push(
        `${untouched.length} existing question(s) of ${existing?.code} are not on this tab; they stay unchanged and count as 0 for imported students.`,
      );
    }
    const untouchedPoints = untouched.reduce((sum, question) => sum + (question.points || 0), 0);
    const totalMarks =
      plannedQuestions.reduce((sum, question) => sum + question.maxMarks, 0) + untouchedPoints;
    const passMark = Math.round((totalMarks * ctx.passRate) / 100);

    const plannedRows: PlannedAssessment['plannedRows'] = [];
    const seenStudents = new Set<string>();
    let blankAsZero = 0;
    for (const row of sheet.rows) {
      const where = `row ${row.rowNumber}`;
      const marks = activeIndexes.map((index) => row.marks[index]);
      const graded = marks.some((mark) => mark !== null);
      if (!row.studentId) {
        if (graded) errors.push(`${where}: marks without a student ID.`);
        continue;
      }
      if (seenStudents.has(row.studentId)) {
        errors.push(`${where}: student ${row.studentId} appears twice on this tab.`);
        continue;
      }
      seenStudents.add(row.studentId);
      if (!graded) continue;

      const rawMarks: Array<number | null> = [];
      let rowValid = true;
      marks.forEach((mark, position) => {
        const question = plannedQuestions[position];
        if (mark === null) {
          blankAsZero += 1;
          rawMarks.push(null);
          return;
        }
        if (typeof mark === 'object') {
          errors.push(`${where} ${question.label}: "${mark.invalid}" is not a number.`);
          rowValid = false;
          rawMarks.push(null);
          return;
        }
        if (mark < 0 || (question.maxMarks > 0 && mark > question.maxMarks + 1e-9)) {
          errors.push(`${where} ${question.label}: ${mark} is outside 0–${question.maxMarks}.`);
          rowValid = false;
        }
        rawMarks.push(mark);
      });
      if (!rowValid) continue;

      const total = round2(rawMarks.reduce<number>((sum, mark) => sum + (mark ?? 0), 0));
      const percent = totalMarks > 0 ? round1((total / totalMarks) * 100) : 0;
      plannedRows.push({
        rowNumber: row.rowNumber,
        studentId: row.studentId,
        name: ctx.students.get(row.studentId)?.name || row.name,
        marks: rawMarks,
        rawMarks,
        total,
        percent,
        studentAction: ctx.students.get(row.studentId)?.action ?? 'create',
      });
    }
    if (blankAsZero > 0) {
      warnings.push(`${blankAsZero} empty mark cell(s) in graded rows are counted as 0.`);
    }
    if (plannedRows.length === 0) {
      warnings.push('No student marks yet — only the assessment and its questions are saved.');
    }

    plannedQuestions.forEach((question, position) => {
      if (question.maxMarks <= 0 || plannedRows.length === 0) return;
      const sum = plannedRows.reduce((acc, row) => acc + (row.rawMarks[position] ?? 0), 0);
      question.averagePercent = round1((sum / (plannedRows.length * question.maxMarks)) * 100);
    });

    // One CLO per question: T = Σ maxMarks, earned = Σ student marks (plain sums).
    const cloTotals = new Map<string, { marks: number; earned: number }>();
    plannedQuestions.forEach((question, position) => {
      const code = question.cloCodes[0];
      if (!code || question.maxMarks <= 0) return;
      const entry = cloTotals.get(code) ?? { marks: 0, earned: 0 };
      entry.marks += question.maxMarks;
      entry.earned += plannedRows.reduce(
        (acc, row) => acc + (row.rawMarks[position] ?? 0),
        0,
      );
      cloTotals.set(code, entry);
    });

    const percents = plannedRows.map((row) => row.percent);
    const passed = plannedRows.filter((row) => row.percent + 1e-9 >= ctx.passRate).length;

    return {
      ...base,
      action: existing ? 'update' : 'create',
      weight,
      totalMarks,
      passMark,
      questions: plannedQuestions.map((question) => omit(question, 'cloIds')),
      rows: plannedRows.map((row) => omit(row, 'rawMarks')),
      untouchedQuestions: untouched.length,
      stats: {
        graded: plannedRows.length,
        averagePercent: percents.length
          ? round1(percents.reduce((sum, value) => sum + value, 0) / percents.length)
          : null,
        highestPercent: percents.length ? Math.max(...percents) : null,
        lowestPercent: percents.length ? Math.min(...percents) : null,
        passed,
        passRatePercent: plannedRows.length ? round1((passed / plannedRows.length) * 100) : null,
      },
      cloMarks: Array.from(cloTotals.entries()).map(([code, entry]) => ({
        code,
        marks: round2(entry.marks),
        averagePercent:
          plannedRows.length > 0 && entry.marks > 0
            ? round1((entry.earned / (entry.marks * plannedRows.length)) * 100)
            : null,
      })),
      errors,
      warnings,
      plannedQuestions,
      plannedRows,
    };
  }

  async import(user: WorkbookUser, courseId: number, file?: Express.Multer.File) {
    const analysis = await this.analyzeFile(user, courseId, file);
    return this.persistAnalysis(user, analysis);
  }

  private async persistAnalysis(user: WorkbookUser, analysis: Analysis) {
    if (!analysis.preview.canImport) {
      const messages = analysis.preview.errors.filter(Boolean);
      throw new BadRequestException({
        message: messages[0] || 'The workbook cannot be saved.',
        detail: messages.join('\n'),
        errors: messages,
      });
    }

    const { course } = analysis;
    const cloTopic = new Map<number, number>();
    for (const topic of course.topics) {
      for (const link of topic.topicClos) {
        if (!cloTopic.has(link.cloId)) cloTopic.set(link.cloId, topic.id);
      }
    }

    const result = await this.prisma.$transaction(
      async (tx) => {
        // ---- Students ----
        const studentIds = new Map<string, number>();
        const toCreate = Array.from(analysis.students.values()).filter((s) => s.action === 'create');
        if (toCreate.length > 0) {
          const created = await tx.student.createManyAndReturn({
            data: toCreate.map((student) => ({
              studentId: student.studentId,
              name: student.name,
              section: student.section || null,
              departement: student.departement || null,
              courseId: course.id,
            })),
            select: { id: true, studentId: true },
          });
          for (const student of created) studentIds.set(student.studentId, student.id);
        }
        let studentsUpdated = 0;
        for (const student of analysis.students.values()) {
          if (student.existingId == null) continue;
          studentIds.set(student.studentId, student.existingId);
          if (student.action !== 'update' && student.action !== 'enroll') continue;
          await tx.student.update({
            where: { id: student.existingId },
            data: {
              ...(student.name ? { name: student.name } : {}),
              ...(student.section ? { section: student.section } : {}),
              ...(student.departement ? { departement: student.departement } : {}),
              ...(student.action === 'enroll' ? { courseId: course.id } : {}),
            },
          });
          studentsUpdated += 1;
        }

        // ---- Assessments, questions, CLO links, grades ----
        let nextCode = await this.nextAssessmentNumber(tx);
        const saved: Array<{ sheetName: string; code: string; title: string; action: string; grades: number }> = [];
        let questionsCreated = 0;
        let questionsUpdated = 0;
        let gradesSaved = 0;

        for (const planned of analysis.assessments) {
          if (planned.action === 'skip') continue;
          const data = {
            type: planned.type.trim(),
            title: planned.title.trim(),
            percentage: planned.weight,
            totalMarks: planned.totalMarks,
            passMark: planned.passMark,
          };

          let assessmentId: number;
          let code: string;
          if (planned.action === 'update' && planned.assessmentId != null) {
            const updated = await tx.assessment.update({
              where: { id: planned.assessmentId },
              data,
              select: { id: true, code: true },
            });
            assessmentId = updated.id;
            code = updated.code;
          } else {
            code = await this.allocateAssessmentCode(tx, nextCode);
            nextCode = Number(code.slice(3)) + 1;
            const created = await tx.assessment.create({
              data: {
                ...data,
                code,
                numberOfVersions: 1,
                academicYear: course.academicYear,
                semester: course.semester,
                generationConfig: { source: WORKBOOK_SOURCE },
                courseId: course.id,
                tenantId: user.tenantId,
              },
              select: { id: true },
            });
            assessmentId = created.id;
          }

          const questionIds: number[] = [];
          const toInsert = planned.plannedQuestions.filter((question) => question.questionId == null);
          const inserted = toInsert.length
            ? await tx.question.createManyAndReturn({
                data: toInsert.map((question) => ({
                  type: question.type,
                  text: question.text,
                  points: question.maxMarks,
                  sortOrder: question.number,
                  topicId: cloTopic.get(question.cloIds[0]) ?? null,
                  assessmentId,
                  courseId: course.id,
                  tenantId: user.tenantId,
                })),
                select: { id: true },
              })
            : [];
          if (inserted.length > 0) {
            await tx.questionClo.createMany({
              data: inserted.flatMap((row, index) =>
                toInsert[index].cloIds.map((cloId) => ({ questionId: row.id, cloId })),
              ),
              skipDuplicates: true,
            });
          }
          questionsCreated += inserted.length;

          let insertIndex = 0;
          for (const question of planned.plannedQuestions) {
            if (question.questionId == null) {
              questionIds.push(inserted[insertIndex].id);
              insertIndex += 1;
              continue;
            }
            questionIds.push(question.questionId);
            if (question.action !== 'update') continue;
            await tx.question.update({
              where: { id: question.questionId },
              data: {
                type: question.type,
                text: question.text,
                points: question.maxMarks,
                topicId: cloTopic.get(question.cloIds[0]) ?? undefined,
              },
            });
            await tx.questionClo.deleteMany({ where: { questionId: question.questionId } });
            await tx.questionClo.createMany({
              data: question.cloIds.map((cloId) => ({ questionId: question.questionId!, cloId })),
              skipDuplicates: true,
            });
            questionsUpdated += 1;
          }

          const cloIds = Array.from(new Set(planned.plannedQuestions.flatMap((q) => q.cloIds)));
          if (cloIds.length > 0) {
            await tx.assessmentClo.createMany({
              data: cloIds.map((cloId) => ({ assessmentId, cloId })),
              skipDuplicates: true,
            });
          }
          const topicCounts = new Map<number, { mcq: number; tf: number }>();
          for (const question of planned.plannedQuestions) {
            const topicId = cloTopic.get(question.cloIds[0]);
            if (topicId == null) continue;
            const entry = topicCounts.get(topicId) ?? { mcq: 0, tf: 0 };
            if (question.type === 'MCQ') entry.mcq += 1;
            if (question.type === 'TRUE_FALSE') entry.tf += 1;
            topicCounts.set(topicId, entry);
          }
          if (topicCounts.size > 0) {
            await tx.assessmentTopic.createMany({
              data: Array.from(topicCounts.entries()).map(([topicId, counts]) => ({
                assessmentId,
                topicId,
                mcqCount: counts.mcq,
                trueFalseCount: counts.tf,
              })),
              skipDuplicates: true,
            });
          }

          const gradedStudentIds = planned.plannedRows
            .map((row) => studentIds.get(row.studentId))
            .filter((id): id is number => id != null);
          if (gradedStudentIds.length > 0) {
            // Re-importing the same workbook replaces its earlier grades instead of stacking them.
            await tx.gradingScan.deleteMany({
              where: {
                assessmentId,
                studentId: { in: gradedStudentIds },
                detectedAnswers: { path: ['source'], equals: WORKBOOK_SOURCE },
              },
            });
          }

          const confirmedAt = new Date();
          const scans = planned.plannedRows.map((row) => ({
            assessmentId,
            tenantId: user.tenantId,
            graderUserId: user.userId,
            status: 'COMPLETED' as const,
            score: row.total,
            maxScore: planned.totalMarks,
            confidence: 1,
            detectedStudentId: row.studentId,
            matchedStudentCode: row.studentId,
            studentId: studentIds.get(row.studentId) ?? null,
            confirmedAt,
            detectedAnswers: {
              source: WORKBOOK_SOURCE,
              sheet: planned.sheetName,
              row: row.rowNumber,
            },
            questionDetails: planned.plannedQuestions.map((question, position) => {
              const earned = row.rawMarks[position] ?? 0;
              return {
                question: position + 1,
                questionId: questionIds[position],
                masterNumber: position + 1,
                maxPoints: question.maxMarks,
                earnedPoints: earned,
                isCorrect: earned + 1e-9 >= question.maxMarks,
                isAnswered: row.rawMarks[position] != null,
                cloCodes: question.cloCodes,
              };
            }),
          }));
          if (scans.length > 0) {
            await tx.gradingScan.createMany({ data: scans });
          }
          gradesSaved += scans.length;
          saved.push({
            sheetName: planned.sheetName,
            code,
            title: planned.title,
            action: planned.action,
            grades: scans.length,
          });
        }

        return {
          studentsCreated: toCreate.length,
          studentsUpdated,
          questionsCreated,
          questionsUpdated,
          gradesSaved,
          assessments: saved,
        };
      },
      { timeout: 180_000, maxWait: 20_000 },
    );

    return result;
  }

  private async nextAssessmentNumber(tx: Prisma.TransactionClient) {
    const latest = await tx.assessment.findFirst({
      where: { code: { startsWith: 'ASM' } },
      orderBy: { code: 'desc' },
      select: { code: true },
    });
    const match = latest?.code?.match(/^ASM(\d+)$/i);
    return match ? Number(match[1]) + 1 : 1;
  }

  private async allocateAssessmentCode(tx: Prisma.TransactionClient, start: number) {
    for (let candidate = start; candidate < start + 50; candidate += 1) {
      const code = `ASM${String(candidate).padStart(6, '0')}`;
      const exists = await tx.assessment.findUnique({ where: { code }, select: { id: true } });
      if (!exists) return code;
    }
    throw new BadRequestException('Could not allocate a unique assessment code.');
  }
}
