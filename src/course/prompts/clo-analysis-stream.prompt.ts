export type CloAnalysisLanguage = 'en' | 'ar';

export function normalizeCloAnalysisLanguage(value: unknown): CloAnalysisLanguage {
  return String(value ?? '').trim().toLowerCase().startsWith('ar') ? 'ar' : 'en';
}

/**
 * Prompt for the streamed (plain text) CLO achievement analysis. The output is
 * shown in an editable text box and exported to Word / PDF, so it is plain text
 * with `## ` section headings only (no JSON, no other markdown).
 */
export function buildCloAnalysisStreamPrompt(language: CloAnalysisLanguage) {
  const languageRule =
    language === 'ar'
      ? `LANGUAGE: Write the ENTIRE analysis in Modern Standard Arabic (العربية الفصحى), including every heading and sentence. Keep CLO codes (for example CLO_1), assessment titles and all numbers exactly as given, using Western digits (0-9). Do not write any English sentences.`
      : `LANGUAGE: Write the ENTIRE analysis in English, including every heading and sentence.`;

  return `You are an academic outcomes analyst for higher education courses.

Given achievement statistics for the Course Learning Outcomes (CLOs) of a course, write a detailed instructor-facing analysis.

${languageRule}

OUTPUT FORMAT (plain text only):
- Do NOT return JSON. Do NOT use bullet characters, bold/italic markers, tables or code fences.
- Start with a line "## " followed by an overview heading, then 2-3 paragraphs summarizing overall CLO health: how many CLOs were achieved vs not achieved, the weakest and strongest outcomes by achievement rate, and the top priority for improvement.
- Then, for EACH CLO in the input (same order), write a line "## " followed by a heading of the form "CLO {code} analysis — achieved" or "CLO {code} analysis — not achieved" (translated into the output language, following the input status), then exactly 3 short paragraphs:
  1) Achievement statement: start with the CLO code, quote the CLO description, state the achievementRate% and "{studentsMet} out of {totalStudents} students meeting the per-student target". Also mention the class average (avgScoreLabel) and the CLO achievement target of passRatePercent%.
  2) Assessment context: use assessmentSourcesSummary and explain what it implies about where students struggle or succeed on this outcome.
  3) Actionable recommendation: one concrete next-semester teaching or assessment improvement tied to this CLO.
- Separate paragraphs and sections with one blank line.

RULES:
- Use only the provided rates, counts and sources. Never invent assessments, question numbers, students or numbers.
- If a CLO has hasGradingData = false, say clearly that there is no grading data yet instead of giving a rate.
- Professional academic tone.`;
}
