/**
 * Slide templates = a visual theme (rendered by the frontend slide stage and
 * the PPTX/PDF builders through `deckMeta.themeId` / `themeColors` /
 * `themeDesign` / `themeBrand`) plus a writing style guide the writer agent
 * follows. Built-in themes are resolved by id on the frontend; institution
 * templates carry their full render spec in `theme`.
 */
export type SlideTemplateStyle = {
  density: 'light' | 'balanced' | 'dense';
  tone: string;
  preferredLayouts: string[];
  visualEmphasis: string;
};

export type SlideTemplate = {
  id: string;
  name: { en: string; ar: string };
  description: { en: string; ar: string };
  bestFor: string[];
  themeId: string;
  themeColors?: Record<string, string>;
  /** Render spec of an institution template: `{ colors, design, brand }`. */
  theme?: Record<string, unknown> | null;
  /** Set for institution templates stored in `slide_templates`. */
  custom?: { dbId: number; source: string; createdById: number | null; createdAt: string };
  style: SlideTemplateStyle;
};

const LECTURE_CHROME =
  'graphic cards (**Term** — claim), CLO coverage bands, Think-about-it panel, numbered knowledge check; no decorative mesh, waves or blobs';

const LECTURE_LAYOUTS = ['TWO_COLUMN', 'DEFINITION', 'EXAMPLE_STEPS', 'BULLETS'];
const STEM_LAYOUTS = ['EXAMPLE_STEPS', 'FORMULA_FOCUS', 'TWO_COLUMN', 'DEFINITION'];

export const SLIDE_TEMPLATES: SlideTemplate[] = [
  {
    id: 'academic-classic',
    name: { en: 'Scholar', ar: 'الباحث' },
    description: {
      en: 'Default university lecture: cream page, gold kickers, navy titles and rounded graphic cards.',
      ar: 'المحاضرة الجامعية الافتراضية: صفحة كريمية وتسميات ذهبية وعناوين كحلية وبطاقات رسومية مستديرة.',
    },
    bestFor: ['university lectures', 'humanities', 'social sciences', 'law', 'education', 'theory-heavy courses'],
    themeId: 'scholar',
    style: {
      density: 'balanced',
      tone: 'formal academic, precise terminology, cite the reference where relevant',
      preferredLayouts: LECTURE_LAYOUTS,
      visualEmphasis: LECTURE_CHROME,
    },
  },
  {
    id: 'harbor',
    name: { en: 'Harbor', ar: 'المرفأ' },
    description: {
      en: 'Deep teal lecture for earth, marine, nursing and environmental systems.',
      ar: 'محاضرة فيروزية عميقة لعلوم الأرض والبحار والتمريض والبيئة.',
    },
    bestFor: ['environmental science', 'nursing', 'geography', 'marine science', 'public health'],
    themeId: 'harbor',
    style: {
      density: 'balanced',
      tone: 'clear and explanatory; connect each concept to a real system',
      preferredLayouts: LECTURE_LAYOUTS,
      visualEmphasis: LECTURE_CHROME,
    },
  },
  {
    id: 'quartz',
    name: { en: 'Quartz', ar: 'كوارتز' },
    description: {
      en: 'Stone-and-ink lecture for architecture, design and research methods.',
      ar: 'محاضرة حجرية وحبرية للعمارة والتصميم ومناهج البحث.',
    },
    bestFor: ['architecture', 'design', 'urban planning', 'research methods', 'arts'],
    themeId: 'quartz',
    style: {
      density: 'light',
      tone: 'clear and assertive; short statements with strong hierarchy',
      preferredLayouts: LECTURE_LAYOUTS,
      visualEmphasis: LECTURE_CHROME,
    },
  },
  {
    id: 'velvet',
    name: { en: 'Velvet', ar: 'المخمل' },
    description: {
      en: 'Burgundy paper with serif titles for law, literature and history.',
      ar: 'ورق خمري وعناوين مذيّلة للقانون والأدب والتاريخ.',
    },
    bestFor: ['law', 'literature', 'history', 'political science', 'languages'],
    themeId: 'velvet',
    style: {
      density: 'balanced',
      tone: 'narrative and precise; connect claims to sources',
      preferredLayouts: ['DEFINITION', 'TWO_COLUMN', 'QUOTE_CALLOUT', 'BULLETS'],
      visualEmphasis: LECTURE_CHROME,
    },
  },
  {
    id: 'linden',
    name: { en: 'Linden', ar: 'الزيزفون' },
    description: {
      en: 'Sage lecture for biology, pharmacy and health sciences.',
      ar: 'محاضرة مريمية للأحياء والصيدلة والعلوم الصحية.',
    },
    bestFor: ['biology', 'pharmacy', 'medicine', 'health sciences', 'agriculture'],
    themeId: 'linden',
    style: {
      density: 'balanced',
      tone: 'clinical clarity; link structure to function',
      preferredLayouts: LECTURE_LAYOUTS,
      visualEmphasis: LECTURE_CHROME,
    },
  },
  {
    id: 'cobalt',
    name: { en: 'Cobalt', ar: 'الكوبالت' },
    description: {
      en: 'Royal-blue lecture for business, economics and information systems.',
      ar: 'محاضرة زرقاء ملكية للأعمال والاقتصاد ونظم المعلومات.',
    },
    bestFor: ['business', 'economics', 'accounting', 'management', 'information systems'],
    themeId: 'cobalt',
    style: {
      density: 'balanced',
      tone: 'executive and concrete; quantify claims and compare options',
      preferredLayouts: ['TWO_COLUMN', 'EXAMPLE_STEPS', 'DEFINITION', 'BULLETS'],
      visualEmphasis: LECTURE_CHROME,
    },
  },
  {
    id: 'facet',
    name: { en: 'Apex', ar: 'أبيكس' },
    description: {
      en: 'Cool navy-and-blue computing lecture: architectures, trade-offs and worked pipelines.',
      ar: 'محاضرة حوسبة كحلية وزرقاء: معماريات ومفاضلات وخطوط معالجة محلولة.',
    },
    bestFor: ['computer science', 'software engineering', 'artificial intelligence', 'data science', 'networks', 'operating systems'],
    themeId: 'facet',
    style: {
      density: 'balanced',
      tone: 'precise and technical; name components, inputs/outputs and trade-offs',
      preferredLayouts: ['TWO_COLUMN', 'EXAMPLE_STEPS', 'DEFINITION', 'BULLETS'],
      visualEmphasis: `${LECTURE_CHROME}; architecture and pipeline diagrams`,
    },
  },
  {
    id: 'stem-visual',
    name: { en: 'Helix', ar: 'هيليكس' },
    description: {
      en: 'STEM lecture on cool paper: formulas, worked examples and labelled figures.',
      ar: 'محاضرة علوم وهندسة على ورق بارد: صيغ وأمثلة محلولة وأشكال مسمّاة.',
    },
    bestFor: ['mathematics', 'physics', 'engineering', 'statistics', 'chemistry'],
    themeId: 'blueprint',
    style: {
      density: 'balanced',
      tone: 'rigorous and step-by-step; show the reasoning, not just the result',
      preferredLayouts: STEM_LAYOUTS,
      visualEmphasis: `${LECTURE_CHROME}; mermaid process diagrams and textbook figures`,
    },
  },
  {
    id: 'life-science',
    name: { en: 'Meridian', ar: 'ميريديان' },
    description: {
      en: 'Warm copper-and-forest lecture for biology, medicine and health sciences.',
      ar: 'محاضرة دافئة بالنحاسي والأخضر للأحياء والطب والعلوم الصحية.',
    },
    bestFor: ['biology', 'medicine', 'nursing', 'pharmacy', 'public health', 'environmental science'],
    themeId: 'botanica',
    style: {
      density: 'balanced',
      tone: 'clinical/scientific clarity; link structure to function',
      preferredLayouts: LECTURE_LAYOUTS,
      visualEmphasis: `${LECTURE_CHROME}; labelled textbook figures first`,
    },
  },
  {
    id: 'editorial-serif',
    name: { en: 'Atelier', ar: 'أتيلييه' },
    description: {
      en: 'Warm paper with serif headlines for literature, history, law and languages.',
      ar: 'ورق دافئ وعناوين مذيّلة للأدب والتاريخ والقانون واللغات.',
    },
    bestFor: ['literature', 'history', 'languages', 'law', 'political science'],
    themeId: 'editorial',
    style: {
      density: 'balanced',
      tone: 'narrative and reflective; connect ideas to sources and context',
      preferredLayouts: ['DEFINITION', 'TWO_COLUMN', 'QUOTE_CALLOUT', 'BULLETS'],
      visualEmphasis: `${LECTURE_CHROME}; primary sources, quotes and timelines`,
    },
  },
  {
    id: 'corporate-pro',
    name: { en: 'Atlas', ar: 'أطلس' },
    description: {
      en: 'Executive lecture in slate and blue: comparisons, tables and quantified claims.',
      ar: 'محاضرة تنفيذية بالرمادي والأزرق: مقارنات وجداول وادعاءات مكمّمة.',
    },
    bestFor: ['accounting', 'finance', 'economics', 'management', 'information systems'],
    themeId: 'slate',
    style: {
      density: 'balanced',
      tone: 'executive and data-driven; quantify claims and compare options',
      preferredLayouts: ['TWO_COLUMN', 'EXAMPLE_STEPS', 'DEFINITION', 'BULLETS'],
      visualEmphasis: `${LECTURE_CHROME}; comparison tables and simple flow diagrams`,
    },
  },
  {
    id: 'tech-dark',
    name: { en: 'Nocturne', ar: 'نوكتورن' },
    description: {
      en: 'Professional dark lecture with gold accents — systems, algorithms and night-mode teaching.',
      ar: 'محاضرة داكنة احترافية بلمسات ذهبية — أنظمة وخوارزميات وعرض ليلي.',
    },
    bestFor: ['computer science', 'software engineering', 'networks', 'operating systems', 'cybersecurity'],
    themeId: 'midnight',
    style: {
      density: 'balanced',
      tone: 'practical and concrete; name components, states and trade-offs',
      preferredLayouts: ['TWO_COLUMN', 'EXAMPLE_STEPS', 'DEFINITION', 'BULLETS'],
      visualEmphasis: `${LECTURE_CHROME}; architecture and sequence diagrams`,
    },
  },
  {
    id: 'coral',
    name: { en: 'Solace', ar: 'سولاس' },
    description: {
      en: 'Warm coral lecture for education, psychology and student-centred teaching.',
      ar: 'محاضرة مرجانية دافئة للتربية وعلم النفس والتعليم المتمحور حول الطالب.',
    },
    bestFor: ['psychology', 'education', 'social work', 'health sciences', 'nursing', 'languages'],
    themeId: 'coral',
    style: {
      density: 'balanced',
      tone: 'warm and student-centred; use relatable scenarios and reflection prompts',
      preferredLayouts: LECTURE_LAYOUTS,
      visualEmphasis: `${LECTURE_CHROME}; a checkpoint every few slides`,
    },
  },
  {
    id: 'swiss-minimal',
    name: { en: 'Swiss', ar: 'سويس' },
    description: {
      en: 'Crisp black-and-red lecture: short statements, strong hierarchy, generous space.',
      ar: 'محاضرة سوداء وحمراء حادة: عبارات قصيرة وتسلسل قوي ومساحة واسعة.',
    },
    bestFor: ['architecture', 'design', 'arts', 'media', 'philosophy'],
    themeId: 'swiss',
    style: {
      density: 'light',
      tone: 'clear and assertive; short statements, strong hierarchy',
      preferredLayouts: ['TWO_COLUMN', 'QUOTE_CALLOUT', 'DEFINITION', 'BULLETS'],
      visualEmphasis: `${LECTURE_CHROME}; few large visuals`,
    },
  },
  {
    id: 'tide',
    name: { en: 'Tide', ar: 'المد' },
    description: {
      en: 'Teal lecture for earth, marine, civil and environmental systems.',
      ar: 'محاضرة فيروزية لعلوم الأرض والبحار والمدني والبيئة.',
    },
    bestFor: ['environmental science', 'earth and marine science', 'geography', 'civil engineering', 'chemistry'],
    themeId: 'tide',
    style: {
      density: 'balanced',
      tone: 'clear and explanatory; connect each concept to a real system or process',
      preferredLayouts: LECTURE_LAYOUTS,
      visualEmphasis: `${LECTURE_CHROME}; process and cycle diagrams`,
    },
  },
  {
    id: 'bauhaus',
    name: { en: 'Bauhaus', ar: 'باوهاوس' },
    description: {
      en: 'Mustard-and-navy lecture on warm paper for design, architecture and geometry.',
      ar: 'محاضرة خردلية وكحلية على ورق دافئ للتصميم والعمارة والهندسة.',
    },
    bestFor: ['architecture', 'design', 'arts', 'mathematics', 'geometry', 'urban planning'],
    themeId: 'bauhaus',
    style: {
      density: 'light',
      tone: 'clear and assertive; short statements with strong hierarchy',
      preferredLayouts: ['TWO_COLUMN', 'DEFINITION', 'QUOTE_CALLOUT', 'FORMULA_FOCUS'],
      visualEmphasis: `${LECTURE_CHROME}; large structural diagrams`,
    },
  },
  {
    id: 'contour',
    name: { en: 'Contour', ar: 'الكنتور' },
    description: {
      en: 'Forest-and-ochre scholarly lecture for geography, history and research methods.',
      ar: 'محاضرة علمية بالأخضر والمغرة للجغرافيا والتاريخ ومناهج البحث.',
    },
    bestFor: ['geography', 'geology', 'history', 'archaeology', 'agriculture', 'research methods'],
    themeId: 'contour',
    style: {
      density: 'balanced',
      tone: 'scholarly and evidence-based; situate ideas in place, time and sources',
      preferredLayouts: LECTURE_LAYOUTS,
      visualEmphasis: `${LECTURE_CHROME}; maps, timelines and annotated figures`,
    },
  },
  {
    id: 'modern-minimal',
    name: { en: 'Prism', ar: 'بريزم' },
    description: {
      en: 'Violet lecture for business, management and communication — one idea per slide.',
      ar: 'محاضرة بنفسجية للأعمال والإدارة والتواصل — فكرة واحدة في كل شريحة.',
    },
    bestFor: ['business', 'management', 'marketing', 'design', 'communication'],
    themeId: 'aurora',
    style: {
      density: 'light',
      tone: 'confident and concise; one idea per slide, real-world cases',
      preferredLayouts: ['TWO_COLUMN', 'QUOTE_CALLOUT', 'DEFINITION', 'BULLETS'],
      visualEmphasis: `${LECTURE_CHROME}; simple framework diagrams`,
    },
  },
  {
    id: 'workshop-interactive',
    name: { en: 'Terra', ar: 'تيرا' },
    description: {
      en: 'Warm terracotta lecture for labs, skills sessions and first-year workshops.',
      ar: 'محاضرة تراكوتا دافئة للمعامل والمهارات وورش السنة الأولى.',
    },
    bestFor: ['labs', 'skills courses', 'practical sessions', 'first-year courses'],
    themeId: 'sunrise',
    style: {
      density: 'light',
      tone: 'engaging and hands-on; address students directly',
      preferredLayouts: ['EXAMPLE_STEPS', 'TWO_COLUMN', 'DEFINITION', 'BULLETS'],
      visualEmphasis: `${LECTURE_CHROME}; a checkpoint or activity every 3–4 slides`,
    },
  },
  {
    id: 'lumen',
    name: { en: 'Halo', ar: 'هالو' },
    description: {
      en: 'Indigo lecture for innovation, media and entrepreneurship.',
      ar: 'محاضرة نيليّة للابتكار والإعلام وريادة الأعمال.',
    },
    bestFor: ['business', 'entrepreneurship', 'marketing', 'innovation', 'communication', 'media'],
    themeId: 'lumen',
    style: {
      density: 'light',
      tone: 'confident and inspiring; one idea per slide backed by a concrete case',
      preferredLayouts: ['TWO_COLUMN', 'QUOTE_CALLOUT', 'DEFINITION', 'BULLETS'],
      visualEmphasis: `${LECTURE_CHROME}; a few strong figures`,
    },
  },
];

export const DEFAULT_TEMPLATE_ID = 'academic-classic';

const CUSTOM_PREFIX = 'custom-';

const DEFAULT_CUSTOM_STYLE: SlideTemplateStyle = {
  density: 'balanced',
  tone: 'clear academic voice matching the institution brand',
  preferredLayouts: LECTURE_LAYOUTS,
  visualEmphasis: LECTURE_CHROME,
};

export const customTemplateId = (dbId: number) => `${CUSTOM_PREFIX}${dbId}`;

export function customTemplateDbId(id: string | null | undefined): number | null {
  if (!id?.startsWith(CUSTOM_PREFIX)) return null;
  const value = Number(id.slice(CUSTOM_PREFIX.length));
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function customTemplateFromRow(row: {
  id: number;
  name: string;
  description: string | null;
  source: string;
  theme: unknown;
  createdById: number | null;
  createdAt: Date;
}): SlideTemplate {
  const theme =
    row.theme && typeof row.theme === 'object' && !Array.isArray(row.theme)
      ? (row.theme as Record<string, unknown>)
      : {};
  const colors =
    theme.colors && typeof theme.colors === 'object' && !Array.isArray(theme.colors)
      ? (theme.colors as Record<string, string>)
      : undefined;
  const description = row.description?.trim() || 'Institution template';
  return {
    id: customTemplateId(row.id),
    name: { en: row.name, ar: row.name },
    description: { en: description, ar: description },
    bestFor: ['any course of this institution'],
    themeId: 'custom',
    themeColors: colors,
    theme,
    custom: {
      dbId: row.id,
      source: row.source,
      createdById: row.createdById,
      createdAt: row.createdAt.toISOString(),
    },
    style: DEFAULT_CUSTOM_STYLE,
  };
}

export function allTemplates(custom: SlideTemplate[] = []): SlideTemplate[] {
  return [...custom, ...SLIDE_TEMPLATES];
}

export function findTemplate(
  id: string | null | undefined,
  custom: SlideTemplate[] = [],
): SlideTemplate {
  return (
    allTemplates(custom).find((template) => template.id === id) ??
    SLIDE_TEMPLATES.find((template) => template.id === DEFAULT_TEMPLATE_ID)!
  );
}

export function templateCatalogForPrompt(custom: SlideTemplate[] = []): string {
  return allTemplates(custom)
    .map((template) =>
      template.custom
        ? `- ${template.id}: "${template.name.en}" — the institution's own branded template (${template.description.en}). Suitable for any field; prefer it when the instructor's institution identity matters.`
        : `- ${template.id}: ${template.description.en} Best for: ${template.bestFor.join(', ')}. Density: ${template.style.density}. Visuals: ${template.style.visualEmphasis}.`,
    )
    .join('\n');
}

/** Theme fields written into `deckMeta` so the saved deck renders without the template. */
export function templateDeckMeta(template: SlideTemplate): Record<string, unknown> {
  const theme = template.theme ?? {};
  return {
    templateId: template.id,
    themeId: template.themeId,
    ...(template.themeColors ? { themeColors: template.themeColors } : {}),
    ...(theme.design ? { themeDesign: theme.design } : {}),
    ...(theme.brand ? { themeBrand: theme.brand } : {}),
  };
}
