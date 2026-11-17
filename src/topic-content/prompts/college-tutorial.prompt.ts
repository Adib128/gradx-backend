import type { CollegeDocumentJob } from '../interfaces/college-document-job.interface';
import {
  SAUDI_UNIVERSITY_PEDAGOGY,
  formatClosForPrompt,
  formatReferencesWithContentForPrompt,
} from './pedagogy.shared';

export const COLLEGE_TUTORIAL_SYSTEM = `You are an experienced university teaching assistant writing NCAAA-aligned 1-hour tutorials for Saudi / Gulf higher education.
Match the college Tutorial_05 style: concise key-concept recap with a formula table, ONE fully worked numerical/method example (data table + step working + final averages/answer + common mistakes), then 4–6 practice problems from easy to hard with empty student answer spaces (Gantt/working tables left blank).
Use measurable verbs. Map every problem to a tutorial LO and a course CLO.
${SAUDI_UNIVERSITY_PEDAGOGY}
Return valid JSON only. No markdown fences.`;

function ctx(job: CollegeDocumentJob) {
  const p = job.params;
  return `
## Document parameters (use these values; do not invent conflicting course identity)
- Kind: TUTORIAL No. ${p.documentNo}
- Title: ${p.title}
- Course code: ${p.courseCode || '—'}
- Course name: ${p.courseName || job.courseTitle}
- Semester: ${p.semester || '—'}
- Instructor: ${p.instructor || '—'}
- Section: ${p.section || '—'}
- Duration: ${p.duration}
- Materials allowed: ${p.toolsOrMaterials}
- Prerequisites: ${p.prerequisites}
- Related lecture / chapter: ${p.relatedLecture}
- Practice problems: ${p.taskOrProblemCount}
- Language: ${p.contentLanguage === 'ar' ? 'Arabic' : 'English'} — write all student-facing text in this language.

## Course
- ${job.courseTitle}
- ${job.courseDescription || ''}

## CLOs
${formatClosForPrompt(job.clos, job.targetedCloIds)}

## References
${formatReferencesWithContentForPrompt(job.references || [])}

## Source teaching content (${job.sourceType}) — authoritative
${JSON.stringify(job.sourceContent ?? {}, null, 2).slice(0, 28000)}
`;
}

export const COLLEGE_TUTORIAL_OVERVIEW_PROMPT = (job: CollegeDocumentJob) => `
Write tutorial information header and learning-outcomes mapping for this 1-hour tutorial.
Style reference: Tutorial_05 — 2–3 measurable LOs, each linked to a course CLO and to the problem numbers that cover it (e.g. "5.1, 5.3–5.5 (a)").
${ctx(job)}

Return ONLY JSON:
{
  "format": "college_tutorial_v1",
  "header": {
    "tutorialNo": ${job.params.documentNo},
    "title": string,
    "courseCode": string,
    "courseName": string,
    "semester": string,
    "instructor": string,
    "section": string,
    "duration": string,
    "materialsAllowed": string,
    "prerequisites": string,
    "relatedLecture": string
  },
  "learningOutcomes": [
    {
      "code": "LO1",
      "outcome": "measurable verb + content",
      "cloCode": "CLO x.y",
      "coveredIn": "5.1, 5.3 (a)"
    }
  ]
}
Use 2-3 learning outcomes. Prerequisites should list prior tutorials/topics and formulas students must already know.`;

export const COLLEGE_TUTORIAL_CONCEPTS_PROMPT = (
  job: CollegeDocumentJob,
  overview: unknown,
) => `
Write KEY CONCEPTS RECAP (at most one page) in Tutorial_05 style.
Only the definitions, rules and formulas students need for THIS tutorial's problems.
Include a formula/concept table (Concept/Formula | Meaning | When to use it) with 3–6 rows.
Optional short notes (units, tie-breaking rules).
${ctx(job)}
Overview: ${JSON.stringify(overview)}

Return ONLY JSON:
{
  "keyConcepts": {
    "intro": string,
    "concepts": [
      { "id": "3.1", "title": string, "body": string }
    ],
    "formulaTable": [
      { "concept": string, "meaning": string, "whenToUse": string }
    ],
    "notes": string[]
  }
}`;

export const COLLEGE_TUTORIAL_WORKED_PROMPT = (
  job: CollegeDocumentJob,
  overview: unknown,
) => `
Write ONE WORKED EXAMPLE in Tutorial_05 style that shows the METHOD students must copy in Section 5.
Requirements:
- Title like "Example 4.1: … (LO1, LO2)".
- Clear problem statement.
- If the topic is numerical/algorithmic, include a dataTable (e.g. Process | Arrival | Burst) with concrete numbers.
- Solution steps: numbered method steps that actually compute the answer (not vague advice).
- finalAnswer with the numeric/result summary (e.g. averages).
- commonMistakes: 3–4 typical student errors for this problem type.
${ctx(job)}
Overview / LOs: ${JSON.stringify(overview)}

Return ONLY JSON:
{
  "workedExample": {
    "id": "4.1",
    "title": string,
    "loCodes": ["LO1", "LO2"],
    "problem": string,
    "dataTable": {
      "headers": ["Process", "Arrival Time (ms)", "Burst Time (ms)"],
      "rows": [["P1", "0", "6"]]
    },
    "steps": [
      { "step": 1, "working": string }
    ],
    "finalAnswer": string,
    "commonMistakes": string
  }
}
If a data table is not natural for the topic, set dataTable to null and still give complete step working.`;

export const COLLEGE_TUTORIAL_PRACTICE_PROMPT = (
  job: CollegeDocumentJob,
  overview: unknown,
) => `
Write ${job.params.taskOrProblemCount} PRACTICE PROBLEMS in Tutorial_05 student-version style (empty answer spaces; do NOT fill solutions).

Arrangement (easy → hard), matching Tutorial_05:
1. 1–2 Level Understand items (short explain / true-false with justification).
2. 2–3 Level Apply items with concrete data tables and multi-part (a)(b)(c)(d) tasks (draw chart / compute averages / fill working table).
3. 1 Level Analyze item that compares methods or links to a prior tutorial/algorithm.

For numerical Apply/Analyze problems include:
- dataTable with process/input rows
- parts: [{ "label": "a", "text": "…" }, …]
- answerSlots describing blank areas students fill:
  - { "type": "text", "label": "Answer" }
  - { "type": "gantt", "label": "Gantt chart" }
  - { "type": "workingTable", "label": "b–d. Working table", "headers": ["Process","AT","BT","CT","TAT = CT − AT","WT = TAT − BT","RT = Start − AT"], "rowLabels": ["P1","P2",…] }
  - { "type": "comparison", "label": "e. Comparison …" }

Every problem must cite LO codes like "(LO1, LO2)".
${ctx(job)}
Overview / LOs: ${JSON.stringify(overview)}

Return ONLY JSON:
{
  "practiceProblems": [
    {
      "id": "5.1",
      "level": "Understand",
      "kind": "practice",
      "question": string,
      "loCodes": ["LO1"],
      "parts": [],
      "dataTable": null,
      "answerSlots": [{ "type": "text", "label": "Answer" }]
    },
    {
      "id": "5.3",
      "level": "Apply",
      "kind": "practice",
      "question": string,
      "loCodes": ["LO1", "LO2"],
      "parts": [
        { "label": "a", "text": "Draw the Gantt chart …" },
        { "label": "b", "text": "Calculate the average waiting time …" }
      ],
      "dataTable": {
        "headers": ["Process", "Arrival Time (ms)", "Burst Time (ms)"],
        "rows": [["P1", "0", "7"]]
      },
      "answerSlots": [
        { "type": "gantt", "label": "a. Gantt chart" },
        {
          "type": "workingTable",
          "label": "b–d. Working table",
          "headers": ["Process", "AT", "BT", "CT", "TAT = CT − AT", "WT = TAT − BT", "RT = Start − AT"],
          "rowLabels": ["P1", "P2", "P3", "P4", "P5"]
        }
      ]
    }
  ],
  "references": string[],
  "furtherPractice": string[]
}`;
