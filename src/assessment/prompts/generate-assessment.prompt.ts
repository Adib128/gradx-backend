// src/topic-content/prompts/generate-assessment.prompt.ts

import { getDifficultyRuleString } from 'src/assessment/config/difficulty-distribution.config';

export const GENERATE_COURSE_PROMPT = (payload: {
  assessment: any;
  topicGenerations: any[];
}): string => {
  const { assessment, topicGenerations } = payload;

  // Resolve the string profile directly from our external config rule mapping
  const difficultyStrategy = getDifficultyRuleString(assessment.difficulty);

  return `
You are an elite university professor and distinguished instructional designer specializing in higher education curricula. Your task is to generate a comprehensive, publication-quality exam sheet and corresponding answer key based on the structural constraints provided below.

The output must be authoritative, rigorous, and tailored precisely to the domain of the course.

========================================================================
REQUEST FORMAT 1: CONTEXTUAL INPUT METADATA (What you are analyzing)
========================================================================
- **Title:** ${assessment.title}
- **Assessment Type:** ${assessment.type}
- **Language:** ${assessment.language}
- **Target Difficulty Profile:** ${assessment.difficulty ?? 'BALANCED'} (${difficultyStrategy})
- **Target Duration:** ${assessment.duration ? `${assessment.duration} minutes` : 'Standard exam block'}
- **Total Marks:** ${assessment.totalMarks ?? 'Distributed proportionally based on question weights'}
- **Passing Mark:** ${assessment.passMark ?? 'Standard institutional threshold'}

### Structural Blueprint by Topic
You MUST strictly construct examination items that align directly with the criteria configurations detailed for each individual topic section below:

${topicGenerations
  .map(
    (tg, index) => `
#### [Topic Block ${index + 1}] ID: ${tg.topicId} — ${tg.topicTitle}
- **Target Course Learning Outcomes (CLOs) to Evaluate:**
${tg.closDetails.map((c: any) => `  * [${c.code}] (${c.category || 'Skill'}): ${c.description}`).join('\n')}
- **Target Cognitive Domains (Bloom's Taxonomy):**
  * ${tg.blooms.map((b: string) => b).join(', ')}
- **Required Question Blueprint (Exact Tally Count):**
${tg.questionTypes.map((q: any) => `  * Generate exactly ${q.questionTypeNumber} item(s) of type: "${q.questionType}"`).join('\n')}
---
`,
  )
  .join('\n')}

========================================================================
OPERATIONAL CONSTRAINTS & FORMATTING RULES (CRITICAL)
========================================================================
1. **JSON Integrity:** Return ONLY a raw, valid JSON object matching Request Format 2 below. Do NOT wrap the JSON inside markdown code blocks (\`\`\`json ... \`\`\`). No conversational preambles or postscripts.
2. **Strict Character Escaping:** Every text block will be evaluated inside a strict machine parser. You MUST thoroughly escape all double quotes (\\") and literal newlines (\\\\n) inside string attributes.
3. **Flexible Math Formats:** Avoid raw LaTeX backslashes (\\\\) inside plain JSON strings to prevent token parsing crashes. Use descriptive text notations for technical components (e.g., "integral from a to b of f(x)dx", "delta_t", "matrix dimension [n x m]").
4. **Distribution Fidelity & Difficulty Calibration:** The final item tally grouped inside your "questions" array must perfectly equal the mathematical sum of all required question counts defined in the blueprint records above. 
   * CRITICAL INTELLECTUAL WEIGHTING: You must calibrate the internal complexity of your generated questions to strictly follow the requested distribution metrics: ${difficultyStrategy}.
5. **Single Master List:** Provide all questions in a single flat array. (Note: Do not worry about multiple exam versions or sequencing variations; the backend system handles shuffling programmatically).

========================================================================
REQUEST FORMAT 2: EXPECTED OUTPUT JSON CONTRACT (What you must return)
========================================================================
Ensure your output matches this structural signature exactly. Property names match backend database schema columns directly:

{
  "questions": [
    {
      "topicId": 1, 
      "type": "Must exactly match one of the requested backend enum values: MCQ or TRUE_FALSE",
      "text": "The comprehensive exam question statement prompt body text.",
      "explanation": "Provide a complete, unambiguous step-by-step master verification explanation, validation path, or core solution strategy required to achieve full credit.",
      "points": 5,
      "options": [
        {
          "text": "Option content text goes here",
          "isCorrect": true,
          "order": 1
        },
        {
          "text": "Distractor choice text goes here",
          "isCorrect": false,
          "order": 2
        }
      ]
    }
  ]
}`.trim();
};
