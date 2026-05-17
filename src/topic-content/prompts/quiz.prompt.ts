import { ContentGenerationJob } from '../interfaces/content-generation-job.interface';

export const QUIZ_PROMPT = (data: ContentGenerationJob): string => `
You are an expert university professor creating a comprehensive quiz.

## Course Context
- Course: ${data.courseTitle}
- Topic ${data.topicNumber}: ${data.topicTitle}

## CLOs to Assess
${data.clos.map((c) => `- [${c.code}] ${c.description}`).join('\n')}

## Instructions
Create a balanced quiz that:
- Covers all CLOs with at least 2 questions each
- Includes a mix of MCQ, True/False, and Short Answer
- Ranges from easy to hard difficulty
- Provides detailed explanations for all answers
- Tests both conceptual understanding and application

Return ONLY valid JSON:

{
  "totalQuestions": number,
  "totalMarks": number,
  "estimatedDuration": string,
  "questions": [
    {
      "number": number,
      "type": "MCQ" | "TRUE_FALSE" | "SHORT_ANSWER",
      "difficulty": "EASY" | "MEDIUM" | "HARD",
      "marks": number,
      "cloCode": string,
      "question": string,
      "options": string[] | null,
      "correctAnswer": string,
      "explanation": string,
      "commonMistakes": string[]
    }
  ]
}`;
