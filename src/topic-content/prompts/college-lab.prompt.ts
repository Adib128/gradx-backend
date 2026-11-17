import type { CollegeDocumentJob } from '../interfaces/college-document-job.interface';
import {
  SAUDI_UNIVERSITY_PEDAGOGY,
  formatClosForPrompt,
  formatReferencesWithContentForPrompt,
} from './pedagogy.shared';

export const COLLEGE_LAB_SYSTEM = `You are an experienced university lab instructor writing NCAAA-aligned lab manuals for Saudi / Gulf higher education.
Follow the college lab-manual structure exactly. Use measurable verbs. Link every assessed task to a lab LO and a course CLO.
${SAUDI_UNIVERSITY_PEDAGOGY}
Return valid JSON only. No markdown fences.`;

function ctx(job: CollegeDocumentJob) {
  const p = job.params;
  return `
## Document parameters (use these values; do not invent conflicting course identity)
- Kind: LAB MANUAL No. ${p.documentNo}
- Title: ${p.title}
- Course code: ${p.courseCode || '—'}
- Course name: ${p.courseName || job.courseTitle}
- Semester: ${p.semester || '—'}
- Instructor: ${p.instructor || '—'}
- Section: ${p.section || '—'}
- Duration: ${p.duration}
- Tools & environment: ${p.toolsOrMaterials}
- Prerequisites: ${p.prerequisites}
- Related lecture / chapter: ${p.relatedLecture}
- Total marks: ${p.totalMarks}
- Guided exercises: ${p.guidedCount}
- Independent tasks: ${p.taskOrProblemCount}
- Post-lab questions: ${p.questionCount}
- Language: ${p.contentLanguage === 'ar' ? 'Arabic' : 'English'} — write all student-facing text in this language.

## Course
- ${job.courseTitle}
- ${job.courseDescription || ''}

## CLOs (prefer topic-linked ones)
${formatClosForPrompt(job.clos, job.targetedCloIds)}

## References
${formatReferencesWithContentForPrompt(job.references || [])}

## Source teaching content (${job.sourceType}) — authoritative; do not invent unrelated topics
${JSON.stringify(job.sourceContent ?? {}, null, 2).slice(0, 28000)}
`;
}

export const COLLEGE_LAB_OVERVIEW_PROMPT = (job: CollegeDocumentJob) => `
Write the lab header, learning outcomes table, and background-theory plan for this college lab manual.
${ctx(job)}

Return ONLY JSON:
{
  "format": "college_lab_v1",
  "header": {
    "labNo": ${job.params.documentNo},
    "title": string,
    "courseCode": string,
    "courseName": string,
    "semester": string,
    "instructor": string,
    "section": string,
    "duration": string,
    "toolsEnvironment": string,
    "prerequisites": string,
    "relatedLecture": string
  },
  "learningOutcomes": [
    {
      "code": "LO1",
      "outcome": "measurable verb + content",
      "cloCode": "CLO x.y",
      "assessedIn": "Task/Q numbers"
    }
  ],
  "theoryPlan": [
    { "id": "3.1", "title": string }
  ]
}
Use 2-4 learning outcomes. theoryPlan: 3-5 concept headings only.`;

export const COLLEGE_LAB_THEORY_PROMPT = (
  job: CollegeDocumentJob,
  overview: unknown,
) => `
Write BACKGROUND THEORY for this lab (at most ~1-2 pages of content). Concise, lab-relevant only.
${ctx(job)}
Overview so far: ${JSON.stringify(overview)}

Return ONLY JSON:
{
  "backgroundTheory": {
    "intro": string,
    "concepts": [
      { "id": "3.1", "title": string, "body": string }
    ],
    "summaryTable": [
      { "name": "function/command", "purpose": string, "returns": string }
    ],
    "summary": string
  }
}`;

export const COLLEGE_LAB_SETUP_PROMPT = (
  job: CollegeDocumentJob,
  overview: unknown,
) => `
Write SETUP & PROCEDURE as exact numbered steps students can follow without verbal help.
${ctx(job)}
Overview: ${JSON.stringify(overview)}

Return ONLY JSON:
{
  "setupProcedure": {
    "notes": string[],
    "steps": [
      { "step": 1, "action": string, "command": string }
    ]
  }
}`;

export const COLLEGE_LAB_EXERCISES_PROMPT = (
  job: CollegeDocumentJob,
  overview: unknown,
) => `
Write ${job.params.guidedCount} GUIDED EXERCISES. For each: purpose, complete runnable code (or exact procedure), ask students to PREDICT before running, then explain.
${ctx(job)}
Overview / LOs: ${JSON.stringify(overview)}

Return ONLY JSON:
{
  "guidedExercises": [
    {
      "id": "5.1",
      "title": string,
      "purpose": string,
      "code": string | null,
      "language": "c" | "python" | "bash" | "other" | null,
      "notes": string[],
      "tryIt": string[]
    }
  ]
}`;

export const COLLEGE_LAB_TASKS_PROMPT = (
  job: CollegeDocumentJob,
  overview: unknown,
) => `
Write ${job.params.taskOrProblemCount} INDEPENDENT TASKS (ASSESSED). Each must state LO codes, clear requirements, deliverables, and implied marks.
${ctx(job)}
Overview / LOs: ${JSON.stringify(overview)}

Return ONLY JSON:
{
  "independentTasks": [
    {
      "id": "6.1",
      "title": string,
      "loCodes": ["LO3"],
      "marks": number,
      "statement": string,
      "requirements": string[],
      "deliverables": string
    }
  ]
}`;

export const COLLEGE_LAB_CLOSING_PROMPT = (
  job: CollegeDocumentJob,
  overview: unknown,
) => `
Finish the lab with POST-LAB QUESTIONS (${job.params.questionCount}), SUBMISSION INSTRUCTIONS, ASSESSMENT RUBRIC totaling ${job.params.totalMarks} marks, and REFERENCES.
${ctx(job)}
Overview / LOs / tasks context: ${JSON.stringify(overview)}

Return ONLY JSON:
{
  "postLabQuestions": [
    { "id": "Q1", "question": string, "loCodes": ["LO1"] }
  ],
  "submission": {
    "what": string,
    "fileNaming": string,
    "where": string,
    "deadline": string
  },
  "rubric": [
    {
      "criterion": string,
      "lo": string,
      "fullMarks": string,
      "partialMarks": string,
      "marks": number
    }
  ],
  "totalMarks": ${job.params.totalMarks},
  "references": string[]
}`;
