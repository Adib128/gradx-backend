import { getDifficultyRuleString } from 'src/assessment/config/difficulty-distribution.config';

const sharedRules = `
========================================================================
OPERATIONAL CONSTRAINTS & FORMATTING RULES (CRITICAL)
========================================================================
1. **JSON Integrity:** Return ONLY a raw, valid JSON object. Do NOT wrap the JSON inside markdown code blocks. No conversational preambles or postscripts.
2. **Strict Character Escaping:** Escape all double quotes (\\") inside strings. Do not include unescaped newlines inside string values.
3. **Safe Math Text:** Prefer plain text math (e.g. "f(x) = x^2", "integral of f(x) dx"). Avoid LaTeX backslashes that break JSON.
4. **Single Master List:** Provide all questions in a single flat "questions" array.
`.trim();

const outputContract = `
========================================================================
EXPECTED OUTPUT JSON CONTRACT
========================================================================
{
  "questions": [
    {
      "topicId": 1,
      "cloCode": "1.1",
      "type": "MCQ or TRUE_FALSE",
      "text": "The exam question statement.",
      "explanation": "Step-by-step solution / verification.",
      "points": 5,
      "options": [
        { "text": "Option text", "isCorrect": true, "order": 1 },
        { "text": "Distractor text", "isCorrect": false, "order": 2 }
      ],
      "allowMultipleCorrect": false
    }
  ]
}
`.trim();

export const GENERATE_COURSE_PROMPT = (payload: {
  assessment: any;
  topicGenerations: any[];
}): string => {
  const { assessment, topicGenerations } = payload;
  const difficultyStrategy = getDifficultyRuleString(assessment.difficulty);

  return `
You are an elite university professor and distinguished instructional designer specializing in higher education curricula. Your task is to generate a comprehensive, publication-quality exam sheet and corresponding answer key based on the structural constraints provided below.

The output must be authoritative, rigorous, and tailored precisely to the domain of the course.

========================================================================
CONTEXTUAL INPUT METADATA
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
- **Required Question Blueprint (Exact Tally Count):**
${tg.questionTypes.map((q: any) => `  * Generate exactly ${q.questionTypeNumber} item(s) of type: "${q.questionType}"`).join('\n')}
---
`,
  )
  .join('\n')}

${sharedRules}
5. **Distribution Fidelity & Difficulty Calibration:** The final item tally must equal the sum of all required question counts. Calibrate complexity to: ${difficultyStrategy}.

${outputContract}
`.trim();
};

const sourceSection = (
  source: { type: string; label: string; excerpt: string } | null | undefined,
): string => {
  if (!source || !source.excerpt.trim()) return '';
  const instruction =
    source.type === 'COURSE_SPECIFICATION'
      ? 'No slides or reference document were provided for this topic. Use the course specification below together with your expert knowledge of the subject to write an accurate question that stays within the topic scope.'
      : 'Base the question strictly on the excerpt below. The question, the correct answer, and the explanation must be supported by this text. Do not ask about content that is not in it.';
  return `
========================================================================
SOURCE MATERIAL — ${source.label}
========================================================================
${instruction}

<<<SOURCE
${source.excerpt}
SOURCE>>>
`;
};

/** Focused prompt used for incremental (one-question-at-a-time) generation. */
export const GENERATE_SINGLE_QUESTION_PROMPT = (payload: {
  assessment: any;
  topicGeneration: any;
  questionType: string;
  questionIndex: number;
  totalQuestions: number;
  existingQuestionTexts: string[];
  source?: { type: string; label: string; excerpt: string } | null;
}): string => {
  const {
    assessment,
    topicGeneration,
    questionType,
    questionIndex,
    totalQuestions,
    existingQuestionTexts,
    source,
  } = payload;
  const difficultyStrategy = getDifficultyRuleString(assessment.difficulty);
  const tg = topicGeneration;

  const avoidList =
    existingQuestionTexts.length > 0
      ? existingQuestionTexts
          .slice(-12)
          .map((text, i) => `  ${i + 1}. ${text.slice(0, 160)}`)
          .join('\n')
      : '  (none yet)';

  return `
You are an elite university professor creating ONE exam question for a higher-education assessment.

Generate exactly ONE question of type "${questionType}" (question ${questionIndex} of ${totalQuestions}).

========================================================================
ASSESSMENT CONTEXT
========================================================================
- **Title:** ${assessment.title}
- **Assessment Type:** ${assessment.type}
- **Language:** ${assessment.language}
- **Difficulty Profile:** ${assessment.difficulty ?? 'BALANCED'} (${difficultyStrategy})

========================================================================
TOPIC TARGET
========================================================================
- **Topic ID:** ${tg.topicId}
- **Topic Title:** ${tg.topicTitle}
- **CLOs:**
${(tg.closDetails || [])
  .map((c: any) => `  * [${c.code}] (${c.category || 'Skill'}): ${c.description}`)
  .join('\n')}

Pick ONE CLO code from the list above for this question and include it as "cloCode" (example: "1.1").
${sourceSection(source)}

========================================================================
AVOID DUPLICATES
========================================================================
Do NOT repeat or closely paraphrase these already-generated questions:
${avoidList}

${sharedRules}
5. Return a "questions" array with exactly ONE item.
6. Set "topicId" to ${tg.topicId}.
7. Set "type" exactly to "${questionType}".
8. For TRUE_FALSE provide exactly 2 options (True/False) with exactly one correct.
9. For MCQ provide 4 options. Most items have exactly one correct option (allowMultipleCorrect=false). When the learning objective needs selecting all that apply, set allowMultipleCorrect=true and mark every correct option with isCorrect=true (2+ options).

${outputContract}
`.trim();
};
