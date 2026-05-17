// src/topic-content/prompts/slides.prompt.ts
import { ContentGenerationJob } from '../interfaces/content-generation-job.interface';

export const SLIDES_PROMPT = (data: ContentGenerationJob): string => `
You are an expert university professor creating professional lecture slides.

## Course Context
- Course: ${data.courseTitle}
- Topic ${data.topicNumber}: ${data.topicTitle}
- Course Description: ${data.courseDescription}

## CLOs to Address
${data.clos.map((c) => `- [${c.code}] ${c.description}`).join('\n')}

## Instructions
Create concise, visually structured slides suitable for a 3-hour university lecture.
Each slide must:
- Have a clear focused title
- Use bullet points (max 5 per slide)
- Include formulas as plain readable text without backslashes
- Include Mermaid diagrams on concept slides
- Include speaker notes for the professor
- Follow a logical pedagogical flow

Return ONLY valid JSON:

{
  "totalSlides": number,
  "slides": [
    {
      "slideNumber": number,
      "type": "TITLE" | "CONTENT" | "FORMULA" | "DIAGRAM" | "EXAMPLE" | "SUMMARY",
      "title": string,
      "bullets": string[],
      "formula": {
        "latex": string,
        "explanation": string
      } | null,
      "diagram": {
        "title": string,
        "mermaid": string
      } | null,
      "example": {
        "problem": string,
        "solution": string
      } | null,
      "cloCode": string | null,
      "speakerNotes": string
    }
  ]
}`;
