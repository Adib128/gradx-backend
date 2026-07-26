import { ContentGenerationJob } from '../interfaces/content-generation-job.interface';
import { contentLanguageGuidance } from '../utils/content-language.util';

/** Shared Saudi / NCAAA-aligned teaching guidance for all topic-content prompts. */
export const SAUDI_UNIVERSITY_PEDAGOGY = `
## Teaching standard (Saudi university / NCAAA-aligned)
You write for university faculty in Saudi Arabia and the Gulf who teach under NCAAA-style course specifications and NQF learning domains (Knowledge / Skills / Values).
- Use constructive alignment: every major teaching block must serve at least one listed CLO (code + domain when provided).
- Prefer measurable Bloom verbs in objectives and formative checks (Define, Explain, Apply, Analyze, Evaluate, Create).
- Classroom voice: precise, formal, teachable — never marketing, never filler, never generic AI tips.
- Worked examples must use concrete numbers/values a professor can write on the board.
- Include at least one common student misconception per substantial module when content allows.
- When "Local Context" examples are requested, prefer authentic Saudi / Gulf / MENA professional settings (industry practice, regulation, Vision 2030-relevant sectors, campus labs) without political advocacy.
- Respect academic integrity: do not fabricate citations, standards, or statistics; if references are unknown, omit them.
`.trim();

export function formatClosForPrompt(
  clos: ContentGenerationJob['clos'],
  targetedCloIds: string[],
): string {
  if (!clos?.length) {
    return '- (none provided)';
  }

  const priority = new Set(
    (targetedCloIds || []).map((id) => String(id).trim().toLowerCase()),
  );

  return clos
    .map((c) => {
      const code = String(c.code || '').trim();
      const domain = [c.category, c.programCLOCode].filter(Boolean).join(' / ');
      const strategies = (c.teachingStrategies || []).filter(Boolean);
      const methods = (c.assessmentMethods || []).filter(Boolean);
      const focused =
        priority.size === 0 ||
        priority.has(code.toLowerCase()) ||
        priority.has(String(c.programCLOCode || '').toLowerCase());
      const focusTag = focused ? ' [PRIORITY]' : '';
      const lines = [
        `- [${code}]${domain ? ` (${domain})` : ''}${focusTag}: ${c.description}`,
      ];
      if (strategies.length) {
        lines.push(`  Teaching strategies: ${strategies.join('; ')}`);
      }
      if (methods.length) {
        lines.push(`  Assessment methods: ${methods.join('; ')}`);
      }
      return lines.join('\n');
    })
    .join('\n');
}

export function qualityModeGuidance(mode: ContentGenerationJob['aiQualityMode']): string {
  switch (mode) {
    case 'Fast':
      return 'Quality mode Fast: prioritize clarity and core definitions; keep modules lean; still include one worked example.';
    case 'Balanced':
      return 'Quality mode Balanced: solid definitions, one worked example, one misconception, and one formative check per module.';
    case 'Publication Quality':
      return 'Quality mode Publication Quality: denser rigor, sharper formalism, richer examples, tighter CLO mapping, and exam-ready formative items.';
    case 'Academic Quality':
    default:
      return 'Quality mode Academic Quality: classroom-ready depth with definitions, intuition, formalism, worked example, misconception, and formative check.';
  }
}

export function localContextGuidance(
  exampleLevels: ContentGenerationJob['exampleLevels'],
): string {
  const wantsLocal = (exampleLevels || []).some((level) =>
    String(level).toLowerCase().includes('local'),
  );
  if (!wantsLocal) return '';
  return `
## Local / regional examples (required when fitting)
Include at least one applied example grounded in Saudi Arabia or the wider Gulf when the topic allows (e.g. regional industry, campus research labs, professional practice, standards used in KSA universities). Keep examples technically accurate and culturally appropriate.
`.trim();
}

export function languageBlock(data: ContentGenerationJob): string {
  return contentLanguageGuidance(data.contentLanguage);
}
