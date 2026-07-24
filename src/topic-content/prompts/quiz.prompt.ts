import { ContentGenerationJob } from '../interfaces/content-generation-job.interface';

export const QUIZ_SYSTEM_PROMPT = `You are an experienced university examiner writing fair, diagnostic assessments.
Questions must test understanding and application, use realistic distractors, and include teaching explanations.
Return valid JSON only.`;

export const QUIZ_PROMPT = (data: ContentGenerationJob): string => `
Create a university quiz for:

## Course Context
- Course: ${data.courseTitle}
- Topic ${data.topicNumber}: ${data.topicTitle}

## CLOs to Assess
${data.clos.map((c) => `- [${c.code}] ${c.description}`).join('\n') || '- (none provided)'}

## Assessment Standards
- Cover each listed CLO with at least 2 questions when CLOs exist.
- Mix MCQ, True/False, and Short Answer.
- Difficulty mix: easy conceptual checks, medium application, hard analysis.
- MCQ distractors must reflect common student mistakes (not silly options).
- Explanations must teach the correct reasoning and name the misconception when relevant.
- Use precise academic wording; avoid trick wording that confuses language rather than knowledge.
- If source lecture content is present, ground items in that scope only.

${
  data.sourceLectureContent
    ? `## Source Lecture Content\n${JSON.stringify(data.sourceLectureContent, null, 2)}`
    : ''
}

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
      "bloomLevel": "Remember" | "Understand" | "Apply" | "Analyze" | "Evaluate" | "Create",
      "question": string,
      "options": string[] | null,
      "correctAnswer": string,
      "explanation": string,
      "commonMistakes": string[]
    }
  ]
}
`;
