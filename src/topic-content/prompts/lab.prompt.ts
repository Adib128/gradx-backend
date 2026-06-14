// src/topic-content/prompts/lab.prompt.ts
import { ContentGenerationJob } from '../interfaces/content-generation-job.interface';

export const LAB_PROMPT = (data: ContentGenerationJob): string => `
You are an expert university professor creating a professional lab manual.

## Course Context
- Course: ${data.courseTitle}
- Topic ${data.topicNumber}: ${data.topicTitle}

## CLOs to Cover
${data.clos.map((c) => `- [${c.code}] ${c.description}`).join('\n')}

## Source Lecture Content
Use the already generated and accepted lecture content below as the authoritative source. Build the lab as a practical extension of this exact lecture. Do not introduce unrelated tools, algorithms, datasets, or learning outcomes unless they directly support the lecture.

${JSON.stringify(data.sourceLectureContent ?? {}, null, 2)}

## Instructions
Create a detailed hands-on lab manual that:
- Has clear step-by-step instructions
- Includes complete working code examples
- Converts the lecture's theory, examples, formulas, and key concepts into practical implementation tasks
- Has checkpoints to verify progress
- Includes realistic scenarios that are directly aligned with the lecture content
- Is completable in a 2-3 hour lab session
- Reuses the lecture's CLO alignment, prerequisites, and learning objectives
- Avoids adding unrelated concepts that were not established by the source lecture

Return ONLY valid JSON:

{
  "title": string,
  "objective": string,
  "estimatedDuration": string,
  "prerequisites": string[],
  "tools": string[],
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
      "cloCode": string
    }
  ],
  "deliverables": string[],
  "gradingCriteria": [
    {
      "criterion": string,
      "points": number,
      "description": string
    }
  ],
  "totalPoints": number
}`;
