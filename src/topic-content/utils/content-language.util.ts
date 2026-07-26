const ARABIC_CHAR =
  /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

/** Detect whether course/topic text is primarily Arabic. */
export function detectContentLanguage(
  ...texts: Array<string | null | undefined>
): 'ar' | 'en' {
  const sample = texts.filter(Boolean).join('\n').trim();
  if (!sample) return 'en';

  const arabic = (sample.match(new RegExp(ARABIC_CHAR.source, 'g')) || []).length;
  const latin = (sample.match(/[A-Za-z]/g) || []).length;

  if (arabic === 0) return 'en';
  if (arabic >= 8 && arabic >= latin * 0.35) return 'ar';
  if (arabic >= latin) return 'ar';
  return 'en';
}

export function contentLanguageGuidance(language: 'ar' | 'en' | undefined): string {
  if (language !== 'ar') {
    return `
## Output language
Write all generated string values in clear academic English.
Keep JSON keys in English (schema). Only string VALUES are localized.
`.trim();
  }

  return `
## Output language (CRITICAL — Arabic)
Detected content language: Arabic (العربية).
- Write ALL generated string VALUES in Modern Standard Arabic (فصحى أكاديمية), including:
  module titles, abstracts, learning objectives, definitions, examples, speaking notes,
  formative checks, assessments, takeaways, diagram titles, case-study titles, and hints.
- Do NOT mix English section headings with Arabic body text inside string values.
- Keep JSON keys in English exactly as required by the schema. Only VALUES are Arabic.
- Bloom labels inside string values use Arabic verbs (يتذكر، يفهم، يطبق، يحلل، يقيّم، يبتكر).
- CLO codes (e.g. 1.1) may stay as codes; describe outcomes in Arabic.
- Mermaid node/edge labels should be Arabic when the diagram is instructional text.
- For lists inside string values, use clear Arabic bullet lines (e.g. "- نقطة") so they render as lists.
`.trim();
}
