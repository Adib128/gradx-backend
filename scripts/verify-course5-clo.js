/**
 * Independently recompute CLO achievement for course 5 and print rows
 * (mirrors course-reports.service weighted S/T logic).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const COURSE_ID = 5;

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  const course = (
    await pool.query(
      `SELECT id, "passRate" FROM courses WHERE id = $1`,
      [COURSE_ID],
    )
  ).rows[0];
  const passRate = course.passRate ?? 70;

  const clos = (
    await pool.query(
      `SELECT id, code FROM clos WHERE "courseId" = $1 ORDER BY id`,
      [COURSE_ID],
    )
  ).rows;

  const students = (
    await pool.query(
      `SELECT id, student_id FROM students WHERE "courseId" = $1 ORDER BY id`,
      [COURSE_ID],
    )
  ).rows;

  const assessments = (
    await pool.query(
      `SELECT id, title, type, percentage, "totalMarks"
       FROM assessments WHERE "courseId" = $1 ORDER BY id`,
      [COURSE_ID],
    )
  ).rows;

  const questions = (
    await pool.query(
      `SELECT q.id, q."assessmentId", q.points,
              array_agg(qc."cloId" ORDER BY qc."cloId") AS clo_ids,
              row_number() OVER (PARTITION BY q."assessmentId" ORDER BY q.id) AS qnum
       FROM questions q
       JOIN question_clos qc ON qc."questionId" = q.id
       WHERE q."assessmentId" = ANY($1::int[])
       GROUP BY q.id
       ORDER BY q."assessmentId", q.id`,
      [assessments.map((a) => a.id)],
    )
  ).rows;

  const scans = (
    await pool.query(
      `SELECT id, "assessmentId", "studentId", "matchedStudentCode", "questionDetails"
       FROM grading_scans
       WHERE status = 'COMPLETED' AND "assessmentId" = ANY($1::int[])`,
      [assessments.map((a) => a.id)],
    )
  ).rows;

  // weights
  const weights = new Map();
  for (const a of assessments) weights.set(a.id, Number(a.percentage) || 0);

  // T
  const cloT = new Map(clos.map((c) => [c.id, 0]));
  const qMeta = new Map(); // assessmentId -> [{qnum, points, cloIds, weighted}]

  for (const a of assessments) {
    const aq = questions.filter((q) => q.assessmentId === a.id);
    const examTotal =
      a.totalMarks && a.totalMarks > 0
        ? a.totalMarks
        : aq.reduce((s, q) => s + q.points, 0);
    const examWeight = weights.get(a.id) || 0;
    const metas = aq.map((q) => {
      const weighted =
        examTotal > 0 && examWeight > 0
          ? (q.points / examTotal) * examWeight
          : 0;
      const cloIds = q.clo_ids;
      for (const cloId of cloIds) {
        cloT.set(cloId, (cloT.get(cloId) || 0) + weighted / cloIds.length);
      }
      return {
        questionNumber: Number(q.qnum),
        points: q.points,
        cloIds,
        weightedPoints: weighted,
      };
    });
    qMeta.set(a.id, metas);
  }

  // student scores
  const studentKeys = students.map((s) => s.student_id);
  const scores = new Map(clos.map((c) => [c.id, new Map(studentKeys.map((k) => [k, 0]))]));

  for (const scan of scans) {
    const student = students.find((s) => s.id === scan.studentId);
    const key = student?.student_id || scan.matchedStudentCode;
    if (!key) continue;
    const metas = qMeta.get(scan.assessmentId) || [];
    const details = scan.questionDetails || [];
    for (const detail of details) {
      const meta = metas.find((m) => m.questionNumber === Number(detail.question));
      if (!meta || !meta.cloIds.length || meta.weightedPoints <= 0) continue;
      const fraction = detail.isCorrect === true ? 1 : 0;
      const earned = (meta.weightedPoints * fraction) / meta.cloIds.length;
      for (const cloId of meta.cloIds) {
        const map = scores.get(cloId);
        map.set(key, (map.get(key) || 0) + earned);
      }
    }
  }

  const n = students.length;
  console.log(`passRate=${passRate}%  students=${n}\n`);
  console.log(
    'CLO'.padEnd(6),
    'S / T'.padEnd(14),
    'Met'.padEnd(8),
    'Rate'.padEnd(8),
    'Status',
  );

  for (const clo of clos) {
    const T = Math.round((cloT.get(clo.id) || 0) * 100) / 100;
    const thr = Math.round(T * (passRate / 100) * 100) / 100;
    const vals = studentKeys.map((k) => scores.get(clo.id).get(k) || 0);
    const S =
      Math.round((vals.reduce((a, b) => a + b, 0) / Math.max(n, 1)) * 100) / 100;
    const met = vals.filter((v) => v >= thr).length;
    const rate = Math.round((met / n) * 1000) / 10;
    const achieved = rate >= passRate;
    console.log(
      clo.code.padEnd(6),
      `${S} / ${T}`.padEnd(14),
      `${met}/${n}`.padEnd(8),
      `${rate}%`.padEnd(8),
      achieved ? 'Achieved' : 'Not achieved',
    );
    // debug per-student
    // console.log('  ', vals.map((v,i)=>`${studentKeys[i]}=${v}`).join(' '));
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
