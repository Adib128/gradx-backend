import { ContentGenerationJob } from '../interfaces/content-generation-job.interface';

export const LAB_SYSTEM_PROMPT = `You are an experienced university lab instructor writing manuals that students can complete independently in a supervised lab.
Prioritize clear procedure, verification checkpoints, realistic deliverables, and CLO-aligned practice.
Return valid JSON only.`;

export const LAB_PROMPT = (data: ContentGenerationJob): string => `
Create a university lab manual that turns this lecture into practical skills.

## Course Context
- Course: ${data.courseTitle}
- Topic ${data.topicNumber}: ${data.topicTitle}

## CLOs to Cover
${data.clos.map((c) => `- [${c.code}] ${c.description}`).join('\n') || '- (none provided)'}

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
- Map sections to CLO codes.
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
