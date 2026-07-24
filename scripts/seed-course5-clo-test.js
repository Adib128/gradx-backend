/**
 * Seed course 5 with students, assessment questions (CLO-linked), and grading scans
 * so CLO achievement S/T math can be validated by hand.
 *
 * Expected weighted totals T (passRate 70%):
 *   K1=25 (thr 17.5), K2=15 (10.5), S1=10 (7), S2=10 (7),
 *   S3=5 (3.5), S4=20 (14), V1=5 (3.5), V2=10 (7)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const COURSE_ID = 5;
const TENANT_ID = 1;
const GRADER_USER_ID = 1;

const CLO = {
  K1: 24,
  K2: 25,
  S1: 26,
  S2: 27,
  S3: 28,
  S4: 29,
  V1: 30,
  V2: 31,
};

const ASSESSMENTS = {
  midterm: 11, // 20%
  lab: 12, // 20%
  quiz: 13, // 10%
  project: 14, // 10%
  final: 15, // 40%
};

/** Question blueprint per assessment: [points, cloCode, text] */
const QUESTIONS = {
  midterm: [
    [10, 'K1', 'Define gradient descent and its convergence criteria.'],
    [10, 'S4', 'Apply Newton’s method to a convex optimization problem.'],
  ],
  quiz: [
    [5, 'K1', 'Recall the definition of a convex set.'],
    [5, 'K2', 'Explain the difference between local and global minima.'],
  ],
  lab: [
    [10, 'S1', 'Implement gradient descent for a quadratic function.'],
    [10, 'S2', 'Debug and tune learning rate schedules in code.'],
  ],
  project: [
    [10, 'S3', 'Design an end-to-end architecture search pipeline.'],
    [10, 'V1', 'Document ethical considerations of the project.'],
  ],
  final: [
    [10, 'K1', 'State KKT conditions for constrained problems.'],
    [10, 'K2', 'Compare first-order and second-order methods.'],
    [10, 'S4', 'Solve a constrained problem using projected gradient.'],
    [10, 'V2', 'Evaluate fairness implications of an optimization model.'],
  ],
};

const TOTAL_MARKS = {
  midterm: 20,
  quiz: 10,
  lab: 20,
  project: 20,
  final: 40,
};

/**
 * Per-student correctness by assessment key → array of booleans (question order).
 * Designed so expected rates are easy to verify.
 */
const STUDENTS = [
  {
    studentId: 'STU001',
    name: 'Alice Achiever',
    section: 'A',
    // full credit everywhere
    answers: {
      midterm: [true, true],
      quiz: [true, true],
      lab: [true, true],
      project: [true, true],
      final: [true, true, true, true],
    },
  },
  {
    studentId: 'STU002',
    name: 'Bob Borderline',
    section: 'A',
    // K1: mid+final only = 20 >= 17.5 ✓; K2: final only = 10 < 10.5 ✗
    // S1: fail; S2: pass; S3: pass; S4: mid+final = 20 ✓; V1: fail; V2: pass
    answers: {
      midterm: [true, true],
      quiz: [false, false],
      lab: [false, true],
      project: [true, false],
      final: [true, true, true, true],
    },
  },
  {
    studentId: 'STU003',
    name: 'Carol Catchup',
    section: 'B',
    // K1: quiz+final = 15 < 17.5 ✗; K2: quiz+final = 15 ✓
    // S1: pass; S2: fail; S3: fail; S4: final only = 10 < 14 ✗; V1: pass; V2: fail
    answers: {
      midterm: [false, false],
      quiz: [true, true],
      lab: [true, false],
      project: [false, true],
      final: [true, true, true, false],
    },
  },
  {
    studentId: 'STU004',
    name: 'Dave Drifter',
    section: 'B',
    // mostly fails; only S1 and V2 pass
    answers: {
      midterm: [false, false],
      quiz: [false, false],
      lab: [true, false],
      project: [false, false],
      final: [false, false, false, true],
    },
  },
  {
    studentId: 'STU005',
    name: 'Eve Exact',
    section: 'A',
    // exactly at thresholds where possible
    // K1: mid+quiz = 15 < 17.5 ✗ (needs one more); with mid+final = 20 ✓
    answers: {
      midterm: [true, true],
      quiz: [true, true],
      lab: [true, true],
      project: [true, true],
      final: [false, false, false, false],
    },
  },
];

/*
Expected per-CLO student scores (weighted):
K1 T=25 thr=17.5 | Alice 25✓ Bob 20✓ Carol 15✗ Dave 0✗ Eve 15✗ → met 2/5 = 40% Not achieved
K2 T=15 thr=10.5 | Alice 15✓ Bob 10✗ Carol 15✓ Dave 0✗ Eve 5✗  → met 2/5 = 40% Not achieved
S1 T=10 thr=7    | Alice 10✓ Bob 0✗  Carol 10✓ Dave 10✓ Eve 10✓ → met 4/5 = 80% Achieved
S2 T=10 thr=7    | Alice 10✓ Bob 10✓ Carol 0✗  Dave 0✗  Eve 10✓ → met 3/5 = 60% Not achieved
S3 T=5  thr=3.5  | Alice 5✓  Bob 5✓  Carol 0✗  Dave 0✗  Eve 5✓  → met 3/5 = 60% Not achieved
S4 T=20 thr=14   | Alice 20✓ Bob 20✓ Carol 10✗ Dave 0✗  Eve 10✗ → met 2/5 = 40% Not achieved
V1 T=5  thr=3.5  | Alice 5✓  Bob 0✗  Carol 5✓  Dave 0✗  Eve 5✓  → met 3/5 = 60% Not achieved
V2 T=10 thr=7    | Alice 10✓ Bob 10✓ Carol 0✗  Dave 10✓ Eve 0✗  → met 3/5 = 60% Not achieved

S averages:
K1: (25+20+15+0+15)/5 = 15 → 15 / 25
K2: (15+10+15+0+5)/5 = 9 → 9 / 15
S1: (10+0+10+10+10)/5 = 8 → 8 / 10
S2: (10+10+0+0+10)/5 = 6 → 6 / 10
S3: (5+5+0+0+5)/5 = 3 → 3 / 5
S4: (20+20+10+0+10)/5 = 12 → 12 / 20
V1: (5+0+5+0+5)/5 = 3 → 3 / 5
V2: (10+10+0+10+0)/5 = 6 → 6 / 10
*/

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Remove prior seed data for this course (keep CLOs / assessments)
    await client.query(
      `DELETE FROM grading_scans
       WHERE "assessmentId" IN (SELECT id FROM assessments WHERE "courseId" = $1)`,
      [COURSE_ID],
    );
    await client.query(
      `DELETE FROM question_clos
       WHERE "questionId" IN (
         SELECT q.id FROM questions q
         JOIN assessments a ON a.id = q."assessmentId"
         WHERE a."courseId" = $1
       )`,
      [COURSE_ID],
    );
    await client.query(
      `DELETE FROM assessment_version_questions
       WHERE "assessmentVersionId" IN (
         SELECT av.id FROM assessment_versions av
         JOIN assessments a ON a.id = av."assessmentId"
         WHERE a."courseId" = $1
       )`,
      [COURSE_ID],
    );
    await client.query(
      `DELETE FROM assessment_versions
       WHERE "assessmentId" IN (SELECT id FROM assessments WHERE "courseId" = $1)`,
      [COURSE_ID],
    );
    await client.query(
      `DELETE FROM questions
       WHERE "assessmentId" IN (SELECT id FROM assessments WHERE "courseId" = $1)`,
      [COURSE_ID],
    );
    await client.query(
      `DELETE FROM students WHERE "courseId" = $1`,
      [COURSE_ID],
    );

    // Update assessment totals
    for (const [key, assessmentId] of Object.entries(ASSESSMENTS)) {
      await client.query(
        `UPDATE assessments SET "totalMarks" = $1, "updatedAt" = NOW() WHERE id = $2`,
        [TOTAL_MARKS[key], assessmentId],
      );
    }

    // Insert questions + CLO links; record question numbers per assessment
    /** @type {Record<string, number[]>} */
    const questionIdsByAssessment = {};

    for (const [key, specs] of Object.entries(QUESTIONS)) {
      const assessmentId = ASSESSMENTS[key];
      questionIdsByAssessment[key] = [];
      for (const [points, cloCode, text] of specs) {
        const inserted = await client.query(
          `INSERT INTO questions
             (type, text, points, bloom, "assessmentId", "courseId", "tenantId", "createdAt", "updatedAt")
           VALUES
             ('MCQ', $1, $2, 'UNDERSTAND', $3, $4, $5, NOW(), NOW())
           RETURNING id`,
          [text, points, assessmentId, COURSE_ID, TENANT_ID],
        );
        const questionId = inserted.rows[0].id;
        questionIdsByAssessment[key].push(questionId);
        await client.query(
          `INSERT INTO question_clos ("questionId", "cloId") VALUES ($1, $2)`,
          [questionId, CLO[cloCode]],
        );
        await client.query(
          `INSERT INTO question_options (text, "isCorrect", "order", "questionId")
           VALUES
             ('Correct option', true, 0, $1),
             ('Distractor A', false, 1, $1),
             ('Distractor B', false, 2, $1),
             ('Distractor C', false, 3, $1)`,
          [questionId],
        );
      }
    }

    // Insert students + grading scans
    for (const student of STUDENTS) {
      const studentRow = await client.query(
        `INSERT INTO students (student_id, name, section, "courseId", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         RETURNING id`,
        [student.studentId, student.name, student.section, COURSE_ID],
      );
      const studentPk = studentRow.rows[0].id;

      for (const [key, correctness] of Object.entries(student.answers)) {
        const assessmentId = ASSESSMENTS[key];
        const details = correctness.map((isCorrect, index) => ({
          question: index + 1,
          isCorrect,
          selectedAnswer: isCorrect ? 'A' : 'B',
        }));
        const maxScore = TOTAL_MARKS[key];
        const score = QUESTIONS[key].reduce(
          (sum, [points], index) => sum + (correctness[index] ? points : 0),
          0,
        );

        await client.query(
          `INSERT INTO grading_scans
             ("assessmentId", "tenantId", "graderUserId", status, confidence,
              "questionDetails", score, "maxScore",
              "detectedStudentId", "matchedStudentCode", "studentId",
              "confirmedAt", "createdAt", "updatedAt")
           VALUES
             ($1, $2, $3, 'COMPLETED', 0.95,
              $4::jsonb, $5, $6,
              $7, $7, $8,
              NOW(), NOW(), NOW())`,
          [
            assessmentId,
            TENANT_ID,
            GRADER_USER_ID,
            JSON.stringify(details),
            score,
            maxScore,
            student.studentId,
            studentPk,
          ],
        );
      }
    }

    await client.query('COMMIT');

    console.log('Seeded course 5 successfully.');
    console.log('Students:', STUDENTS.map((s) => s.studentId).join(', '));
    console.log('Questions per assessment:', questionIdsByAssessment);
    console.log('\nExpected CLO achievement (passRate 70%):');
    console.log(`
CLO | S / T     | Met | Rate | Status
K1  | 15 / 25   | 2/5 | 40%  | Not achieved
K2  | 9 / 15    | 2/5 | 40%  | Not achieved
S1  | 8 / 10    | 4/5 | 80%  | Achieved
S2  | 6 / 10    | 3/5 | 60%  | Not achieved
S3  | 3 / 5     | 3/5 | 60%  | Not achieved
S4  | 12 / 20   | 2/5 | 40%  | Not achieved
V1  | 3 / 5     | 3/5 | 60%  | Not achieved
V2  | 6 / 10    | 3/5 | 60%  | Not achieved
`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
