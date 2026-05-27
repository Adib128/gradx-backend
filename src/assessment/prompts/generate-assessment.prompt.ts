// src/topic-content/prompts/generate-assessment.prompt.ts

export const GENERATE_COURSE_PROMPT = (payload: {
  assessment: any;
  topicGenerations: any[];
}): string => {
  const { assessment, topicGenerations } = payload;

  return `
You are an elite university professor and distinguished instructional designer specializing in higher education curricula. Your task is to generate a comprehensive, publication-quality exam sheet and corresponding answer key based on the structural constraints provided below.

The output must be authoritative, rigorous, and tailored precisely to the domain of the course.

## 1. Assessment Parameters
- **Title:** ${assessment.title}
- **Assessment Type:** ${assessment.type}
- **Language:** ${assessment.language}
- **Target Duration:** ${assessment.duration ? `${assessment.duration} minutes` : 'Standard exam block'}
- **Total Points:** ${assessment.totalPoints ?? 'Distributed proportionally based on question weights'}
- **Passing Mark:** ${assessment.passMark ?? 'Standard institutional threshold'}

## 2. Structural Blueprint by Topic
You MUST strictly construct examination items that align directly with the criteria configurations detailed for each individual topic section below:

${topicGenerations
  .map(
    (tg, index) => `
### [Topic Block ${index + 1}] ID: ${tg.topicId} — ${tg.topicTitle}

#### Target Course Learning Outcomes (CLOs) to Evaluate:
${tg.closDetails.map((c: any) => `- [${c.code}] (${c.category || 'Skill'}): ${c.description}`).join('\n')}

#### Target Cognitive Domains (Bloom's Taxonomy):
${tg.blooms.map((b: string) => `- ${b}`).join(', ')}

#### Required Question Blueprint (Exact Tally Count):
${tg.questionTypes.map((q: any) => `- Generate exactly ${q.questionTypeNumber} item(s) of type: "${q.questionType}"`).join('\n')}
---
`,
  )
  .join('\n')}

## 3. Operational Constraints & Formatting Rules (CRITICAL)
1. **JSON Integrity:** Return ONLY a raw, valid JSON object matching the signature structural block defined below. Do NOT wrap the JSON inside markdown code blocks (\`\`\`json ... \`\`\`). No conversational preambles or postscripts.
2. **Strict Character Escaping:** Every text block will be evaluated inside a strict machine parser. You MUST thoroughly escape all double quotes (\") and literal newlines (\\n) inside string attributes.
3. **Flexible Math Formats:** Avoid raw LaTeX backslashes (\\) inside plain JSON strings to prevent token parsing crashes. Use descriptive text notations for technical components (e.g., "integral from a to b of f(x)dx", "delta_t", "matrix dimension [n x m]").
4. **Distribution Fidelity:** The final item tally grouped inside your "questions" array must perfectly equal the mathematical sum of all required question counts defined in the blueprint records above.

## 4. Expected JSON Schema Output Structure
Ensure your output matches this structural signature exactly:

{
  "examMetadata": {
    "title": "${assessment.title}",
    "type": "${assessment.type}",
    "language": "${assessment.language}",
    "durationMinutes": ${assessment.duration ?? 120}
  },
  "instructionsForStudents": [
    "Read all questions carefully before beginning.",
    "Show all intermediate steps and derivations where applicable to receive full credit."
  ],
  "questions": [
    {
      "questionNumber": 1,
      "associatedTopicId": 1, 
      "type": "Must match one of the requested types (e.g., MULTIPLE_CHOICE, CODING_EXERCISE, MATH_EQUATION)",
      "bloomLevel": "Selected target taxonomy level used for this question",
      "targetCloCode": "The matching CLO code from that topic's pool",
      "allocatedPoints": 10,
      "questionStatement": "The comprehensive exam question statement prompt body text.",
      "options": [
        "Option A (Only populate if multiple choice type, otherwise set array to null)"
      ],
      "exhaustiveAnswerKey": "Provide the complete, unabridged step-by-step master verification answer, validation test path, or strategic rubric baseline required to achieve full credit.",
      "gradingRubricCriteria": [
        {
          "milestoneDescription": "Partial execution milestone or conceptual validation step",
          "pointsAwarded": 5
        }
      ]
    }
  ],
  "totalCalculatedPoints": 100
}`.trim();
};
