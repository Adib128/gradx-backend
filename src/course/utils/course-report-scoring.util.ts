import { orderQuestionsForSheet } from 'src/grading/answer-sheet-layout';

export const DEFAULT_PASS_RATE_PERCENT = 70;

export const GRADE_BANDS = [
  { grade: 'A+', min: 90, max: 100, markRange: '90-100', gpa: 4.0 },
  { grade: 'A', min: 85, max: 89, markRange: '85-89', gpa: 3.75 },
  { grade: 'B+', min: 80, max: 84, markRange: '80-84', gpa: 3.5 },
  { grade: 'B', min: 75, max: 79, markRange: '75-79', gpa: 3.0 },
  { grade: 'C+', min: 70, max: 74, markRange: '70-74', gpa: 2.5 },
  { grade: 'F', min: 0, max: 69, markRange: '0-69', gpa: 0 },
] as const;

export type GradeBand = (typeof GRADE_BANDS)[number];

export const round1 = (value: number) => Math.round(value * 10) / 10;
export const round2 = (value: number) => Math.round(value * 100) / 100;

export function resolvePassRate(passRate: number | null | undefined) {
  return Number.isFinite(passRate) && (passRate as number) >= 0
    ? (passRate as number)
    : DEFAULT_PASS_RATE_PERCENT;
}

/** Grades and pass/fail are decided on the course total rounded to the nearest whole mark. */
export function scoreToGradeBand(score: number): GradeBand {
  const rounded = Math.round(score);
  return (
    GRADE_BANDS.find((band) => rounded >= band.min && rounded <= band.max) ??
    GRADE_BANDS[GRADE_BANDS.length - 1]
  );
}

export function isPassingTotal(total: number, passRatePercent: number) {
  return Math.round(total) >= passRatePercent;
}

export type RosterStudent = { id: number; studentId: string | null };

export const rosterKey = (student: RosterStudent) =>
  student.studentId || `student-${student.id}`;

export type ReportScanRow = {
  id: number;
  assessmentId: number;
  score: number | null;
  maxScore: number | null;
  studentId: number | null;
  matchedStudentCode: string | null;
  detectedStudentId: string | null;
  decodedFormId: number | null;
  questionDetails: unknown;
};

export type SelectedScan = {
  studentKey: string;
  assessmentId: number;
  score: number;
  maxScore: number;
  decodedFormId: number | null;
  questionDetails: Array<Record<string, unknown>>;
};

/**
 * One result per student per assessment. `scans` must be confirmed scans
 * ordered newest-confirmed first; the first scan seen for a student wins.
 * With a roster, scans that do not belong to an enrolled student are dropped.
 */
export function selectStudentScans(
  scans: ReportScanRow[],
  roster: RosterStudent[],
): SelectedScan[] {
  const keyById = new Map(roster.map((student) => [student.id, rosterKey(student)]));
  const rosterKeys = new Set(keyById.values());
  const seen = new Set<string>();
  const selected: SelectedScan[] = [];

  for (const scan of scans) {
    const score = Number(scan.score);
    const maxScore = Number(scan.maxScore);
    if (!Number.isFinite(score) || !Number.isFinite(maxScore) || maxScore <= 0) {
      continue;
    }

    const code = (scan.matchedStudentCode ?? scan.detectedStudentId ?? '').trim();
    let studentKey: string | null = null;
    if (scan.studentId != null && keyById.has(scan.studentId)) {
      studentKey = keyById.get(scan.studentId)!;
    } else if (rosterKeys.size > 0) {
      studentKey = code && rosterKeys.has(code) ? code : null;
    } else {
      studentKey =
        code || (scan.studentId != null ? `student-${scan.studentId}` : `scan-${scan.id}`);
    }
    if (!studentKey) continue;

    const dedupeKey = `${studentKey}|${scan.assessmentId}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    selected.push({
      studentKey,
      assessmentId: scan.assessmentId,
      score,
      maxScore,
      decodedFormId: scan.decodedFormId,
      questionDetails: Array.isArray(scan.questionDetails)
        ? (scan.questionDetails as Array<Record<string, unknown>>)
        : [],
    });
  }

  return selected;
}

/**
 * Assessment maximum shown in reports: the assessment's total marks when set,
 * otherwise the highest scan maximum.
 */
export function resolveAssessmentMax(
  totalMarks: number | null | undefined,
  scanMaxes: number[],
) {
  if (Number.isFinite(totalMarks) && (totalMarks as number) > 0) {
    return totalMarks as number;
  }
  return scanMaxes.length > 0 ? Math.max(...scanMaxes) : 0;
}

/** Scan score re-expressed on the assessment's maximum (e.g. 45/50 → 90/100). */
export function scaleScanScore(scan: SelectedScan, assessmentMax: number) {
  return assessmentMax > 0 ? (scan.score / scan.maxScore) * assessmentMax : scan.score;
}

/**
 * Explicit `percentage` wins. Assessments without one share the weight left
 * over from 100% equally. When explicit weights exceed 100% and every
 * assessment of a type carries the same value, that value is treated as the
 * type's shared weight (two quizzes stored as 10 → 5 each).
 */
export function resolveAssessmentWeights(
  assessments: Array<{ id: number; type: string; percentage: number | null }>,
) {
  const weights = new Map<number, number>();
  const hasPercentage = (value: number | null) =>
    value != null && Number.isFinite(value) && value >= 0;
  const withPercentage = assessments.filter((a) => hasPercentage(a.percentage));
  const withoutPercentage = assessments.filter((a) => !hasPercentage(a.percentage));

  for (const assessment of withPercentage) {
    weights.set(assessment.id, Number(assessment.percentage));
  }

  if (withoutPercentage.length > 0) {
    const assigned = withPercentage.reduce((sum, a) => sum + Number(a.percentage), 0);
    const share = Math.max(0, 100 - assigned) / withoutPercentage.length;
    for (const assessment of withoutPercentage) {
      weights.set(assessment.id, share);
    }
  }

  const totalWeight = Array.from(weights.values()).reduce((sum, value) => sum + value, 0);
  if (totalWeight > 100.01) {
    const byType = new Map<string, typeof assessments>();
    for (const assessment of assessments) {
      const type = String(assessment.type || 'OTHER');
      byType.set(type, [...(byType.get(type) ?? []), assessment]);
    }
    for (const group of byType.values()) {
      if (group.length < 2) continue;
      const explicit = group
        .map((assessment) => weights.get(assessment.id) ?? 0)
        .filter((value) => value > 0);
      if (explicit.length !== group.length) continue;
      if (new Set(explicit).size === 1) {
        for (const assessment of group) {
          weights.set(assessment.id, explicit[0] / group.length);
        }
      }
    }
  }

  return weights;
}

/** A single assessment in scope counts for the whole 100%. */
export function resolveScopedWeights(
  assessments: Array<{ id: number; type: string; percentage: number | null }>,
  assessmentId?: number,
) {
  return assessmentId
    ? new Map(assessments.map((assessment) => [assessment.id, 100]))
    : resolveAssessmentWeights(assessments);
}

/** Course total out of 100: Σ (scan score / scan max × 100) × assessment weight / 100. */
export function computeStudentTotals(
  scans: SelectedScan[],
  weights: Map<number, number>,
) {
  const totals = new Map<string, number>();
  for (const scan of scans) {
    const weight = weights.get(scan.assessmentId) ?? 0;
    if (weight <= 0) continue;
    const contribution = (scan.score / scan.maxScore) * 100 * (weight / 100);
    totals.set(scan.studentKey, (totals.get(scan.studentKey) ?? 0) + contribution);
  }
  return new Map(Array.from(totals.entries()).map(([key, value]) => [key, round1(value)]));
}

type QuestionRow = {
  id: number;
  type: string | null;
  points: number;
  topicId: number | null;
  questionClos: Array<{ cloId: number }>;
};

export type CloScoringAssessment = {
  id: number;
  title: string;
  questions: QuestionRow[];
  assessmentVersions: Array<{ versionQuestions: Array<{ question: QuestionRow }> }>;
};

type CloQuestion = { id: number; type: string | null; points: number; cloIds: number[] };

export type AssessmentSource = {
  assessmentId: number;
  title: string;
  cloMarks: number;
  questionNumbers: number[];
};

const ASSESSMENT_METHOD_KEYWORDS = [
  'midterm',
  'final',
  'quiz',
  'lab',
  'project',
  'exam',
  'assignment',
];

export function assessmentMatchesMethod(assessmentTitle: string, method: string) {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const title = normalize(assessmentTitle);
  const methodText = normalize(method);
  if (!title || !methodText) return false;
  if (title.includes(methodText) || methodText.includes(title)) return true;
  const compactTitle = title.replace(/s$/g, '');
  const compactMethod = methodText.replace(/s$/g, '');
  if (compactTitle.includes(compactMethod) || compactMethod.includes(compactTitle)) {
    return true;
  }
  const titleKeys = ASSESSMENT_METHOD_KEYWORDS.filter((key) => title.includes(key));
  const methodKeys = ASSESSMENT_METHOD_KEYWORDS.filter((key) => methodText.includes(key));
  return titleKeys.some((key) => methodKeys.includes(key));
}

/**
 * CLO marks on the course-weight scale.
 *
 * Question q of assessment a is worth w_q = points_q / Σ points_a × weight_a,
 * split evenly across its CLOs (question CLO links, otherwise its topic's
 * CLOs). CLO max T = Σ shares. A student earns the share of every question
 * answered correctly; results without per-question details (Excel imports)
 * earn score/max of every share. Without any question links, assessments are
 * matched to CLOs through the CLO assessment methods instead.
 */
export function computeCloScores(options: {
  clos: Array<{ id: number; assessmentMethods: string[] }>;
  topics: Array<{ id: number; topicClos: Array<{ cloId: number }> }>;
  assessments: CloScoringAssessment[];
  weights: Map<number, number>;
  scans: SelectedScan[];
}) {
  const courseCloIds = new Set(options.clos.map((clo) => clo.id));
  const topicCloMap = new Map(
    options.topics.map((topic) => [topic.id, topic.topicClos.map((link) => link.cloId)]),
  );
  const toQuestion = (row: QuestionRow): CloQuestion => {
    const linked = row.questionClos.map((link) => link.cloId);
    const ids =
      linked.length > 0
        ? linked
        : row.topicId != null
          ? (topicCloMap.get(row.topicId) ?? [])
          : [];
    return {
      id: row.id,
      type: row.type,
      points: row.points > 0 ? row.points : 1,
      cloIds: Array.from(new Set(ids)).filter((id) => courseCloIds.has(id)),
    };
  };

  const cloTotals = new Map<number, number>(options.clos.map((clo) => [clo.id, 0]));
  const cloSources = new Map<number, AssessmentSource[]>(
    options.clos.map((clo) => [clo.id, []]),
  );
  const studentCloScores = new Map<number, Map<string, number>>(
    options.clos.map((clo) => [clo.id, new Map()]),
  );
  const addStudentScore = (cloId: number, studentKey: string, amount: number) => {
    const scores = studentCloScores.get(cloId);
    if (!scores || amount <= 0) return;
    scores.set(studentKey, (scores.get(studentKey) ?? 0) + amount);
  };

  const models = new Map(
    options.assessments.map((assessment) => {
      const versions = assessment.assessmentVersions
        .filter((version) => version.versionQuestions.length > 0)
        .map((version) =>
          orderQuestionsForSheet(version.versionQuestions.map((vq) => toQuestion(vq.question))),
        );
      const master = versions[0] ?? orderQuestionsForSheet(assessment.questions.map(toQuestion));
      const byId = new Map<number, CloQuestion>();
      for (const question of [...master, ...versions.flat()]) byId.set(question.id, question);
      const pointsTotal = master.reduce((sum, question) => sum + question.points, 0);
      return [assessment.id, { assessment, versions, master, byId, pointsTotal }] as const;
    }),
  );

  const questionWeight = (assessmentId: number, question: CloQuestion) => {
    const model = models.get(assessmentId);
    const weight = options.weights.get(assessmentId) ?? 0;
    return model && model.pointsTotal > 0 ? (question.points / model.pointsTotal) * weight : 0;
  };

  for (const { assessment, master } of models.values()) {
    const perClo = new Map<number, { marks: number; questionNumbers: number[] }>();
    master.forEach((question, index) => {
      const weighted = questionWeight(assessment.id, question);
      if (question.cloIds.length === 0 || weighted <= 0) return;
      const share = weighted / question.cloIds.length;
      for (const cloId of question.cloIds) {
        cloTotals.set(cloId, (cloTotals.get(cloId) ?? 0) + share);
        const entry = perClo.get(cloId) ?? { marks: 0, questionNumbers: [] };
        entry.marks += share;
        entry.questionNumbers.push(index + 1);
        perClo.set(cloId, entry);
      }
    });
    for (const [cloId, info] of perClo.entries()) {
      cloSources.get(cloId)?.push({
        assessmentId: assessment.id,
        title: assessment.title,
        cloMarks: round2(info.marks),
        questionNumbers: info.questionNumbers,
      });
    }
  }

  const usesQuestionLinks = Array.from(cloTotals.values()).some((value) => value > 0);

  if (usesQuestionLinks) {
    for (const scan of options.scans) {
      const model = models.get(scan.assessmentId);
      if (!model) continue;
      const credit = (question: CloQuestion | undefined, fraction: number) => {
        if (!question || question.cloIds.length === 0) return;
        const share = (questionWeight(scan.assessmentId, question) * fraction) / question.cloIds.length;
        for (const cloId of question.cloIds) addStudentScore(cloId, scan.studentKey, share);
      };

      if (scan.questionDetails.length === 0) {
        const fraction = Math.min(1, Math.max(0, scan.score / scan.maxScore));
        for (const question of model.master) credit(question, fraction);
        continue;
      }

      for (const detail of scan.questionDetails) {
        if (detail.isCorrect !== true) continue;
        const questionId = Number(detail.questionId);
        let question = Number.isInteger(questionId) ? model.byId.get(questionId) : undefined;
        if (!question) {
          const versionNumber = Number(detail.versionNumber ?? scan.decodedFormId ?? 1);
          const sheet =
            (Number.isInteger(versionNumber) && versionNumber > 0
              ? model.versions[versionNumber - 1]
              : undefined) ?? model.master;
          question = sheet[Number(detail.question) - 1];
        }
        credit(question, 1);
      }
    }
  } else {
    for (const { assessment } of models.values()) {
      const weight = options.weights.get(assessment.id) ?? 0;
      if (weight <= 0) continue;
      const matched = options.clos.filter((clo) =>
        (clo.assessmentMethods || []).some((method) =>
          assessmentMatchesMethod(assessment.title, method),
        ),
      );
      if (matched.length === 0) continue;
      const share = weight / matched.length;
      for (const clo of matched) {
        cloTotals.set(clo.id, (cloTotals.get(clo.id) ?? 0) + share);
        cloSources.get(clo.id)?.push({
          assessmentId: assessment.id,
          title: assessment.title,
          cloMarks: round2(share),
          questionNumbers: [],
        });
      }
      for (const scan of options.scans) {
        if (scan.assessmentId !== assessment.id) continue;
        const fraction = Math.min(1, Math.max(0, scan.score / scan.maxScore));
        for (const clo of matched) addStudentScore(clo.id, scan.studentKey, share * fraction);
      }
    }
  }

  return { cloTotals, cloSources, studentCloScores };
}
