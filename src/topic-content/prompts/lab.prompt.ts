// src/topic-content/prompts/lab.prompt.ts
import { ContentGenerationJob } from '../interfaces/content-generation-job.interface';

export const LAB_PROMPT = (data: ContentGenerationJob): string => `
You are an expert university professor creating a professional lab manual.

## Course Context
- Course: ${data.courseTitle}
- Topic ${data.topicNumber}: ${data.topicTitle}

## CLOs to Cover
${data.clos.map((c) => `- [${c.code}] ${c.description}`).join('\n')}

## Instructions
Create a detailed hands-on lab manual that:
- Has clear step-by-step instructions
- Includes complete working code examples
- Covers both theory and practical implementation
- Has checkpoints to verify progress
- Includes real datasets or realistic scenarios
- Is completable in a 2-3 hour lab session

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
