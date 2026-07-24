/**
 * Add 10 more students (STU006–STU015) + grading scans to course 5.
 * Keeps existing students/questions intact.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const COURSE_ID = 5;
const TENANT_ID = 1;
const GRADER_USER_ID = 1;

const ASSESSMENTS = {
  midterm: { id: 11, totalMarks: 20, points: [10, 10] },
  lab: { id: 12, totalMarks: 20, points: [10, 10] },
  quiz: { id: 13, totalMarks: 10, points: [5, 5] },
  project: { id: 14, totalMarks: 20, points: [10, 10] },
  final: { id: 15, totalMarks: 40, points: [10, 10, 10, 10] },
};

const NEW_STUDENTS = [
  {
    studentId: 'STU006',
    name: 'Frank Fullmarks',
    section: 'A',
    answers: {
      midterm: [true, true],
      quiz: [true, true],
      lab: [true, true],
      project: [true, true],
      final: [true, true, true, true],
    },
  },
  {
    studentId: 'STU007',
    name: 'Grace Good',
    section: 'A',
    answers: {
      midterm: [true, true],
      quiz: [true, true],
      lab: [true, true],
      project: [true, true],
      final: [true, true, true, false],
    },
  },
  {
    studentId: 'STU008',
    name: 'Hank Halfway',
    section: 'A',
    answers: {
      midterm: [true, false],
      quiz: [true, false],
      lab: [true, false],
      project: [true, false],
      final: [true, false, true, false],
    },
  },
  {
    studentId: 'STU009',
    name: 'Ivy Improving',
    section: 'B',
    answers: {
      midterm: [false, true],
      quiz: [false, true],
      lab: [false, true],
      project: [false, true],
      final: [false, true, false, true],
    },
  },
  {
    studentId: 'STU010',
    name: 'Jake Justpass',
    section: 'B',
    // K1: mid+final=20✓  K2: quiz+final=15✓  S1✗ S2✓ S3✗ V1✓ S4: mid+final=20✓ V2✓
    answers: {
      midterm: [true, true],
      quiz: [false, true],
      lab: [false, true],
      project: [false, true],
      final: [true, true, true, true],
    },
  },
  {
    studentId: 'STU011',
    name: 'Kara Knowledge',
    section: 'B',
    // strong knowledge, weak skills/values
    answers: {
      midterm: [true, false],
      quiz: [true, true],
      lab: [false, false],
      project: [false, false],
      final: [true, true, false, false],
    },
  },
  {
    studentId: 'STU012',
    name: 'Leo Labpro',
    section: 'A',
    // strong labs/project, weak exams
    answers: {
      midterm: [false, false],
      quiz: [false, false],
      lab: [true, true],
      project: [true, true],
      final: [false, false, false, false],
    },
  },
  {
    studentId: 'STU013',
    name: 'Mia Mixed',
    section: 'A',
    answers: {
      midterm: [true, true],
      quiz: [true, false],
      lab: [true, false],
      project: [true, true],
      final: [true, false, true, true],
    },
  },
  {
    studentId: 'STU014',
    name: 'Nina Narrow',
    section: 'B',
    answers: {
      midterm: [false, false],
      quiz: [true, true],
      lab: [true, true],
      project: [false, false],
      final: [false, true, false, false],
    },
  },
  {
    studentId: 'STU015',
    name: 'Omar Overall',
    section: 'B',
    answers: {
      midterm: [true, true],
      quiz: [true, true],
      lab: [true, true],
      project: [true, false],
      final: [true, true, false, true],
    },
  },
];

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Remove any prior STU006–STU015 for a clean re-run
    const ids = NEW_STUDENTS.map((s) => s.studentId);
    await client.query(
      `DELETE FROM grading_scans
       WHERE "studentId" IN (
         SELECT id FROM students WHERE "courseId" = $1 AND student_id = ANY($2::text[])
       )`,
      [COURSE_ID, ids],
    );
    await client.query(
      `DELETE FROM students WHERE "courseId" = $1 AND student_id = ANY($2::text[])`,
      [COURSE_ID, ids],
    );

    for (const student of NEW_STUDENTS) {
      const studentRow = await client.query(
        `INSERT INTO students (student_id, name, section, "courseId", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         RETURNING id`,
        [student.studentId, student.name, student.section, COURSE_ID],
      );
      const studentPk = studentRow.rows[0].id;

      for (const [key, correctness] of Object.entries(student.answers)) {
        const assessment = ASSESSMENTS[key];
        const details = correctness.map((isCorrect, index) => ({
          question: index + 1,
          isCorrect,
          selectedAnswer: isCorrect ? 'A' : 'B',
        }));
        const score = assessment.points.reduce(
          (sum, points, index) => sum + (correctness[index] ? points : 0),
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
            assessment.id,
            TENANT_ID,
            GRADER_USER_ID,
            JSON.stringify(details),
            score,
            assessment.totalMarks,
            student.studentId,
            studentPk,
          ],
        );
      }
    }

    await client.query('COMMIT');

    const count = await pool.query(
      `SELECT COUNT(*)::int AS n FROM students WHERE "courseId" = $1`,
      [COURSE_ID],
    );
    const scans = await pool.query(
      `SELECT COUNT(*)::int AS n FROM grading_scans
       WHERE "assessmentId" IN (SELECT id FROM assessments WHERE "courseId" = $1)`,
      [COURSE_ID],
    );

    console.log(`Added ${NEW_STUDENTS.length} students: ${ids.join(', ')}`);
    console.log(`Course 5 now has ${count.rows[0].n} students, ${scans.rows[0].n} grading scans.`);
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
