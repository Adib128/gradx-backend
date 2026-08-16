import { ContentGenerationJob } from '../interfaces/content-generation-job.interface';
import {
  SAUDI_UNIVERSITY_PEDAGOGY,
  formatClosForPrompt,
  localContextGuidance,
  languageBlock,
  qualityModeGuidance,
  formatReferencesWithContentForPrompt,
} from './pedagogy.shared';

export const LAB_SYSTEM_PROMPT = `You are an experienced university lab instructor in Saudi / Gulf higher education writing manuals students can complete in a supervised lab.
Prioritize clear procedure, verification checkpoints, realistic deliverables, and CLO-aligned practice.
${SAUDI_UNIVERSITY_PEDAGOGY}
Return valid JSON only.`;

export const LAB_PROMPT = (data: ContentGenerationJob): string => `
Create a university lab manual that turns this lecture into practical skills.

## Course Context
- Course: ${data.courseTitle}
- Topic ${data.topicNumber}: ${data.topicTitle}
- Audience: ${data.audience}
- Difficulty: ${data.difficulty}
- ${qualityModeGuidance(data.aiQualityMode)}

## CLOs to Cover (constructive alignment)
${formatClosForPrompt(data.clos, data.targetedCloIds)}

${localContextGuidance(data.exampleLevels)}

${languageBlock(data)}

## Source Lecture Content (authoritative)
Build the lab as a practical extension of this lecture only. Do not introduce unrelated tools, algorithms, datasets, or outcomes unless required to practice the lecture ideas.

${JSON.stringify(data.sourceLectureContent ?? {}, null, 2)}

## Lab Design Standards
- Completable in 2-3 hours by a prepared undergraduate / matching audience.
- Start with objective, prerequisites, required tools, and safety/setup notes if needed.
- Convert theory, examples, and formulas from the lecture into implementation tasks.
- Every major section needs: short theory link to lecture, numbered steps, expected output, and a checkpoint.
- Provide complete, runnable example snippets or precise procedures (not pseudo stubs).
- Include at least one debugging/common-error note.
- Include one optional stretch task for stronger students.
- Map sections to CLO codes; prefer Skills-domain CLOs for hands-on work when available.
- Provide an instructor-usable grading rubric with clear point allocation.

Return ONLY valid JSON:

{
  "title": string,
  "objective": string,
  "estimatedDuration": string,
  "prerequisites": string[],
  "tools": string[],
  "setupNotes": string[],
  "sections": [
    {
      "sectionNumber": number,
      "title": string,
      "objective": string,
      "theory": string,
      "steps": [
        {
          "stepNumber": number,
          "instruction": string,
          "code": string | null,
          "language": string | null,
          "expectedOutput": string | null,
          "explanation": string
        }
      ],
      "checkpoint": string,
      "commonErrors": string[],
      "cloCode": string
    }
  ],
  "stretchChallenge": string,
  "deliverables": string[],
  "gradingCriteria": [
    {
      "criterion": string,
      "points": number,
      "description": string
    }
  ],
  "totalPoints": number
}
`;

const labContext = (data: ContentGenerationJob) => `
Course: ${data.courseTitle}
Topic ${data.topicNumber}: ${data.topicTitle}
Audience: ${data.audience}
Difficulty: ${data.difficulty}
CLOs:
${formatClosForPrompt(data.clos, data.targetedCloIds)}
Language:
${languageBlock(data)}
Course references / source excerpts (use when relevant to the lab procedure):
${formatReferencesWithContentForPrompt(data.references || [])}
Source lecture (authoritative):
${JSON.stringify(data.sourceLectureContent ?? {}, null, 2)}
`;

export const LAB_PLAN_PROMPT = (data: ContentGenerationJob): string => `
Plan a practical 2-3 hour university lab based only on the supplied lecture.
${labContext(data)}

Return ONLY JSON:
{
  "title": string,
  "sectionCount": number,
  "sections": [
    { "sectionNumber": number, "title": string, "cloCode": string }
  ]
}
Use 3-5 sections in a teachable order.`;

export const LAB_OVERVIEW_PROMPT = (
  data: ContentGenerationJob,
  plan: unknown,
): string => `
Write the overview and setup for this planned lab.
${labContext(data)}
Plan: ${JSON.stringify(plan)}

Return ONLY JSON:
{
  "title": string,
  "objective": string,
  "estimatedDuration": string,
  "prerequisites": string[],
  "tools": string[],
  "setupNotes": string[]
}`;

export const LAB_SECTION_PROMPT = (
  data: ContentGenerationJob,
  section: { sectionNumber: number; title: string; cloCode: string },
): string => `
Write one complete, runnable section for the planned lab.
${labContext(data)}
Section: ${JSON.stringify(section)}

Requirements:
- Connect explicitly to the source lecture.
- Provide complete runnable code or an exact hands-on procedure, never pseudo stubs.
- Every step needs an expected result where applicable.
- Include a verification checkpoint and concrete common errors.

Return ONLY JSON:
{
  "sectionNumber": ${section.sectionNumber},
  "title": ${JSON.stringify(section.title)},
  "objective": string,
  "theory": string,
  "steps": [
    {
      "stepNumber": number,
      "instruction": string,
      "code": string | null,
      "language": string | null,
      "expectedOutput": string | null,
      "explanation": string
    }
  ],
  "checkpoint": string,
  "commonErrors": string[],
  "cloCode": ${JSON.stringify(section.cloCode)}
}`;

export const LAB_CLOSING_PROMPT = (
  data: ContentGenerationJob,
  sections: Array<{ sectionNumber: number; title: string; cloCode: string }>,
): string => `
Finish this university lab with a stretch task, deliverables, and a 100-point
instructor-usable grading rubric.
${labContext(data)}
Completed sections: ${JSON.stringify(sections)}

Return ONLY JSON:
{
  "stretchChallenge": string,
  "deliverables": string[],
  "gradingCriteria": [
    { "criterion": string, "points": number, "description": string }
  ],
  "totalPoints": 100
}`;
