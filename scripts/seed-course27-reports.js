/**
 * Seed course 27 with assessments, students, CLO-linked questions, and grading scans
 * so Reports tabs (student results, CLO achievement, grade distribution, etc.) have data.
 *
 * Assessment plan (matches student-results UX screenshot weights):
 *   Quizzes 15% /15 | Assign 5% /5 | Midterm 20% /20 | Lab 20% /20 | Final 40% /40
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const COURSE_ID = 27;
const TENANT_ID = 1;
const GRADER_USER_ID = 1;

const CLO = {
  '1.1': 153,
  '1.2': 154,
  '2.1': 155,
  '2.2': 156,
  '2.3': 157,
  '2.4': 158,
  '3.1': 159,
  '3.2': 160,
};

/** Assessment definitions created by this seed */
const ASSESSMENT_DEFS = {
  quiz: {
    type: 'QUIZ',
    title: 'Quizzes',
    percentage: 15,
    totalMarks: 15,
    questions: [
      [5, '1.1', 'Recall the definition of a convex set and give an example.'],
      [5, '1.2', 'Explain the difference between local and global minima.'],
      [5, '1.1', 'State the first-order optimality condition for smooth functions.'],
    ],
  },
  assign: {
    type: 'OTHER',
    title: 'Assign',
    percentage: 5,
    totalMarks: 5,
    questions: [
      [5, '3.1', 'Write a short reflection on ethical use of optimization in AI.'],
    ],
  },
  midterm: {
    type: 'MID_TERM_EXAM',
    title: 'Midterm',
    percentage: 20,
    totalMarks: 20,
    questions: [
      [10, '1.1', 'Derive the gradient and Hessian of a quadratic objective.'],
      [10, '2.4', 'Apply Newton’s method to a convex unconstrained problem.'],
    ],
  },
  lab: {
    type: 'LAB',
    title: 'Lab',
    percentage: 20,
    totalMarks: 20,
    questions: [
      [10, '2.1', 'Implement gradient descent for a quadratic function in code.'],
      [10, '2.2', 'Debug and tune learning-rate schedules for SGD.'],
    ],
  },
  final: {
    type: 'FINAL_EXAM',
    title: 'Final',
    percentage: 40,
    totalMarks: 40,
    questions: [
      [10, '1.2', 'Compare first-order and second-order optimization methods.'],
      [10, '2.4', 'Solve a constrained problem using projected gradient descent.'],
      [10, '2.3', 'Design an end-to-end Bayesian optimization experiment.'],
      [10, '3.2', 'Evaluate fairness implications of an optimization model.'],
    ],
  },
};

/**
 * Students with per-assessment correctness arrays matching question order.
 * Scores are chosen to spread totals across distribution bands.
 */
const STUDENTS = [
  {
    studentId: '27001001',
    name: 'Alice Achiever',
    section: 'A',
    answers: {
      quiz: [true, true, true],
      assign: [true],
      midterm: [true, true],
      lab: [true, true],
      final: [true, true, true, true],
    },
  },
  {
    studentId: '27001002',
    name: 'Bob Borderline',
    section: 'A',
    answers: {
      quiz: [true, true, false],
      assign: [true],
      midterm: [true, true],
      lab: [true, false],
      final: [true, true, true, false],
    },
  },
  {
    studentId: '27001003',
    name: 'Carol Catchup',
    section: 'B',
    answers: {
      quiz: [true, false, true],
      assign: [true],
      midterm: [true, false],
      lab: [true, true],
      final: [true, false, true, true],
    },
  },
  {
    studentId: '27001004',
    name: 'Dave Drifter',
    section: 'B',
    answers: {
      quiz: [false, true, false],
      assign: [false],
      midterm: [true, false],
      lab: [true, false],
      final: [false, true, false, true],
    },
  },
  {
    studentId: '27001005',
    name: 'Eve Exact',
    section: 'A',
    answers: {
      quiz: [true, true, true],
      assign: [true],
      midterm: [true, true],
      lab: [true, true],
      final: [true, true, false, true],
    },
  },
  {
    studentId: '27001006',
    name: 'Frank Fair',
    section: 'A',
    answers: {
      quiz: [true, true, true],
      assign: [true],
      midterm: [true, true],
      lab: [false, true],
      final: [true, true, true, true],
    },
  },
  {
    studentId: '27001007',
    name: 'Grace Good',
    section: 'B',
    answers: {
      quiz: [true, false, true],
      assign: [true],
      midterm: [false, true],
      lab: [true, true],
      final: [true, true, false, false],
    },
  },
  {
    studentId: '27001008',
    name: 'Hank Hardwork',
    section: 'B',
    answers: {
      quiz: [false, false, true],
      assign: [true],
      midterm: [true, true],
      lab: [true, true],
      final: [true, false, true, true],
    },
  },
  {
    studentId: '27001009',
    name: 'Ivy Insight',
    section: 'A',
    answers: {
      quiz: [true, true, true],
      assign: [true],
      midterm: [true, true],
      lab: [true, true],
      final: [true, true, true, false],
    },
  },
  {
    studentId: '27001010',
    name: 'Jake Journey',
    section: 'A',
    answers: {
      quiz: [true, true, false],
      assign: [false],
      midterm: [false, true],
      lab: [false, true],
      final: [true, true, false, true],
    },
  },
  {
    studentId: '27001011',
    name: 'Kara Keen',
    section: 'B',
    answers: {
      quiz: [false, true, true],
      assign: [true],
      midterm: [true, true],
      lab: [true, false],
      final: [false, true, true, true],
    },
  },
  {
    studentId: '27001012',
    name: 'Leo Low',
    section: 'B',
    answers: {
      quiz: [false, false, false],
      assign: [false],
      midterm: [false, true],
      lab: [true, false],
      final: [false, false, true, false],
    },
  },
];

function scoreFromAnswers(key, correctness) {
  const questions = ASSESSMENT_DEFS[key].questions;
  return questions.reduce(
    (sum, [points], index) => sum + (correctness[index] ? points : 0),
    0,
  );
}

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const course = await client.query(
      `SELECT id, "tenantId" FROM courses WHERE id = $1`,
      [COURSE_ID],
    );
    if (course.rows.length === 0) {
      throw new Error(`Course ${COURSE_ID} not found`);
    }

    // Clean prior seed data for this course
    await client.query(
      `DELETE FROM grading_scans
       WHERE "assessmentId" IN (SELECT id FROM assessments WHERE "courseId" = $1)`,
      [COURSE_ID],
    );
    await client.query(
      `DELETE FROM question_options
       WHERE "questionId" IN (
         SELECT q.id FROM questions q
         JOIN assessments a ON a.id = q."assessmentId"
         WHERE a."courseId" = $1
       )`,
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
      `DELETE FROM assessment_topic
       WHERE "assessmentId" IN (SELECT id FROM assessments WHERE "courseId" = $1)`,
      [COURSE_ID],
    );
    await client.query(
      `DELETE FROM questions
       WHERE "assessmentId" IN (SELECT id FROM assessments WHERE "courseId" = $1)`,
      [COURSE_ID],
    );
    await client.query(`DELETE FROM assessments WHERE "courseId" = $1`, [
      COURSE_ID,
    ]);
    await client.query(`DELETE FROM students WHERE "courseId" = $1`, [
      COURSE_ID,
    ]);

    const topic = await client.query(
      `SELECT id FROM topics WHERE "courseId" = $1 ORDER BY "topicNumber" ASC LIMIT 1`,
      [COURSE_ID],
    );
    const topicId = topic.rows[0]?.id ?? null;

    /** @type {Record<string, number>} */
    const assessmentIds = {};
    /** @type {Record<string, number[]>} */
    const questionIdsByAssessment = {};

    for (const [key, def] of Object.entries(ASSESSMENT_DEFS)) {
      const inserted = await client.query(
        `INSERT INTO assessments
           (type, title, percentage, "totalMarks", "passMark", "courseId", "tenantId",
            "isPublished", "createdAt", "updatedAt")
         VALUES
           ($1, $2, $3, $4, $5, $6, $7, true, NOW(), NOW())
         RETURNING id`,
        [
          def.type,
          def.title,
          def.percentage,
          def.totalMarks,
          Math.round(def.totalMarks * 0.7),
          COURSE_ID,
          TENANT_ID,
        ],
      );
      const assessmentId = inserted.rows[0].id;
      assessmentIds[key] = assessmentId;
      questionIdsByAssessment[key] = [];

      if (topicId) {
        await client.query(
          `INSERT INTO assessment_topic ("assessmentId", "topicId")
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [assessmentId, topicId],
        );
      }

      const version = await client.query(
        `INSERT INTO assessment_versions
           ("versionName", "assessmentId", "createdAt", "updatedAt")
         VALUES ('A', $1, NOW(), NOW())
         RETURNING id`,
        [assessmentId],
      );
      const versionId = version.rows[0].id;

      for (let i = 0; i < def.questions.length; i++) {
        const [points, cloCode, text] = def.questions[i];
        const q = await client.query(
          `INSERT INTO questions
             (type, text, points, bloom, "assessmentId", "courseId", "tenantId",
              "topicId", "createdAt", "updatedAt")
           VALUES
             ('MCQ', $1, $2, 'UNDERSTAND', $3, $4, $5, $6, NOW(), NOW())
           RETURNING id`,
          [text, points, assessmentId, COURSE_ID, TENANT_ID, topicId],
        );
        const questionId = q.rows[0].id;
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
        await client.query(
          `INSERT INTO assessment_version_questions
             ("assessmentVersionId", "questionId", "order")
           VALUES ($1, $2, $3)`,
          [versionId, questionId, i + 1],
        );
      }
    }

    const summary = [];

    for (const student of STUDENTS) {
      const studentRow = await client.query(
        `INSERT INTO students (student_id, name, section, "courseId", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         RETURNING id`,
        [student.studentId, student.name, student.section, COURSE_ID],
      );
      const studentPk = studentRow.rows[0].id;

      let weightedTotal = 0;

      for (const [key, correctness] of Object.entries(student.answers)) {
        const def = ASSESSMENT_DEFS[key];
        const assessmentId = assessmentIds[key];
        const details = correctness.map((isCorrect, index) => ({
          question: index + 1,
          isCorrect,
          score: isCorrect ? def.questions[index][0] : 0,
          points: def.questions[index][0],
          selectedAnswer: isCorrect ? 'A' : 'B',
        }));
        const maxScore = def.totalMarks;
        const score = scoreFromAnswers(key, correctness);
        weightedTotal += (score / maxScore) * def.percentage;

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

      summary.push({
        studentId: student.studentId,
        name: student.name,
        total: Math.round(weightedTotal * 10) / 10,
      });
    }

    await client.query('COMMIT');

    console.log('Seeded course 27 successfully.');
    console.log('Assessments:', assessmentIds);
    console.log('Questions:', questionIdsByAssessment);
    console.log('\nStudent weighted totals (/100):');
    for (const row of summary.sort((a, b) => b.total - a.total)) {
      console.log(`  ${row.studentId}  ${row.total.toFixed(1)}  ${row.name}`);
    }
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
