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

export const SLIDE_TEMPLATES: SlideTemplate[] = [
  {
    id: 'lumen',
    name: { en: 'Lumen', ar: 'لومن' },
    description: {
      en: 'Glowing indigo-and-rose mesh covers with airy content slides — modern and premium.',
      ar: 'أغلفة متوهجة بدرجات النيلي والوردي مع شرائح محتوى خفيفة — عصري وفاخر.',
    },
    bestFor: ['business', 'entrepreneurship', 'marketing', 'innovation', 'communication', 'media'],
    themeId: 'lumen',
    style: {
      density: 'light',
      tone: 'confident and inspiring; one idea per slide backed by a concrete case',
      preferredLayouts: ['QUOTE_CALLOUT', 'BULLETS', 'TWO_COLUMN', 'DEFINITION'],
      visualEmphasis: 'simple framework diagrams and a few strong figures; generous whitespace',
    },
  },
  {
    id: 'tide',
    name: { en: 'Tide', ar: 'المد' },
    description: {
      en: 'Layered ocean waves in teal and deep blue — calm, fluid and clear.',
      ar: 'أمواج متراكبة بالأزرق المخضر والأزرق العميق — هادئ وانسيابي وواضح.',
    },
    bestFor: ['environmental science', 'earth and marine science', 'geography', 'civil engineering', 'chemistry', 'nursing'],
    themeId: 'tide',
    style: {
      density: 'balanced',
      tone: 'clear and explanatory; connect each concept to a real system or process',
      preferredLayouts: ['BULLETS', 'TWO_COLUMN', 'EXAMPLE_STEPS', 'DEFINITION'],
      visualEmphasis: 'process/cycle diagrams and labelled figures',
    },
  },
  {
    id: 'bauhaus',
    name: { en: 'Bauhaus', ar: 'باوهاوس' },
    description: {
      en: 'Geometric navy-and-mustard arcs on warm paper — bold, structured and creative.',
      ar: 'أقواس هندسية بالكحلي والخردلي على ورق دافئ — جريء ومنظم ومبدع.',
    },
    bestFor: ['architecture', 'design', 'arts', 'mathematics', 'geometry', 'urban planning'],
    themeId: 'bauhaus',
    style: {
      density: 'light',
      tone: 'clear and assertive; short statements with strong hierarchy',
      preferredLayouts: ['BULLETS', 'TWO_COLUMN', 'QUOTE_CALLOUT', 'FORMULA_FOCUS'],
      visualEmphasis: 'few, large visuals and clean structural diagrams',
    },
  },
  {
    id: 'facet',
    name: { en: 'Facet', ar: 'الأوجه' },
    description: {
      en: 'Crystalline low-poly blue and cyan — sharp and technical for computing and engineering.',
      ar: 'مضلعات بلورية بالأزرق والسماوي — حاد وتقني للحوسبة والهندسة.',
    },
    bestFor: ['computer science', 'artificial intelligence', 'data science', 'electrical engineering', 'physics'],
    themeId: 'facet',
    style: {
      density: 'balanced',
      tone: 'precise and technical; name components, inputs/outputs and trade-offs',
      preferredLayouts: ['BULLETS', 'TWO_COLUMN', 'EXAMPLE_STEPS', 'FORMULA_FOCUS'],
      visualEmphasis: 'architecture, pipeline and flow diagrams',
    },
  },
  {
    id: 'coral',
    name: { en: 'Coral', ar: 'المرجان' },
    description: {
      en: 'Soft organic shapes in coral and deep teal with rounded cards — warm and human.',
      ar: 'أشكال عضوية ناعمة بالمرجاني والأزرق المخضر العميق مع بطاقات دائرية — دافئ وإنساني.',
    },
    bestFor: ['psychology', 'education', 'social work', 'health sciences', 'nursing', 'languages'],
    themeId: 'coral',
    style: {
      density: 'balanced',
      tone: 'warm and student-centred; use relatable scenarios and reflection prompts',
      preferredLayouts: ['BULLETS', 'QUOTE_CALLOUT', 'DEFINITION', 'TWO_COLUMN'],
      visualEmphasis: 'concept maps and a checkpoint every few slides',
    },
  },
  {
    id: 'contour',
    name: { en: 'Contour', ar: 'الكنتور' },
    description: {
      en: 'Topographic contour lines in forest green and ochre with serif headings — scholarly and grounded.',
      ar: 'خطوط كنتورية طبوغرافية بالأخضر الغامق والمغرة مع عناوين مذيّلة — رصين وعلمي.',
    },
    bestFor: ['geography', 'geology', 'history', 'archaeology', 'agriculture', 'research methods'],
    themeId: 'contour',
    style: {
      density: 'balanced',
      tone: 'scholarly and evidence-based; situate ideas in place, time and sources',
      preferredLayouts: ['BULLETS', 'TWO_COLUMN', 'DEFINITION', 'QUOTE_CALLOUT'],
      visualEmphasis: 'maps, timelines and annotated figures',
    },
  },
  {
    id: 'academic-classic',
    name: { en: 'Scholar', ar: 'الباحث' },
    description: {
      en: 'Refined university lecture: serif headings, structured bullets, references.',
      ar: 'محاضرة جامعية أنيقة: عناوين بخط مذيّل ونقاط منظمة ومراجع.',
    },
    bestFor: ['humanities', 'social sciences', 'law', 'education', 'theory-heavy courses'],
    themeId: 'scholar',
    style: {
      density: 'balanced',
      tone: 'formal academic, precise terminology, cite the reference where relevant',
      preferredLayouts: ['BULLETS', 'DEFINITION', 'TWO_COLUMN', 'QUOTE_CALLOUT'],
      visualEmphasis: 'one supporting visual per section; text carries the argument',
    },
  },
  {
    id: 'stem-visual',
    name: { en: 'Blueprint', ar: 'المخطط الهندسي' },
    description: {
      en: 'Diagram-first engineering/maths deck with formulas and worked examples.',
      ar: 'عرض يبدأ بالمخططات للهندسة والرياضيات مع صيغ وأمثلة محلولة.',
    },
    bestFor: ['mathematics', 'physics', 'engineering', 'statistics', 'chemistry'],
    themeId: 'blueprint',
    style: {
      density: 'balanced',
      tone: 'rigorous and step-by-step; show the reasoning, not just the result',
      preferredLayouts: ['FORMULA_FOCUS', 'EXAMPLE_STEPS', 'BULLETS', 'TWO_COLUMN'],
      visualEmphasis: 'frequent mermaid flow/process diagrams and textbook figures',
    },
  },
  {
    id: 'tech-dark',
    name: { en: 'Midnight Code', ar: 'منتصف الليل البرمجي' },
    description: {
      en: 'Dark computing deck: architectures, algorithms, step-by-step processes.',
      ar: 'عرض حاسوبي داكن: معماريات وخوارزميات وعمليات خطوة بخطوة.',
    },
    bestFor: ['computer science', 'software engineering', 'networks', 'operating systems', 'cybersecurity', 'data science'],
    themeId: 'midnight',
    style: {
      density: 'balanced',
      tone: 'practical and concrete; name components, states and trade-offs',
      preferredLayouts: ['BULLETS', 'TWO_COLUMN', 'EXAMPLE_STEPS', 'DEFINITION'],
      visualEmphasis: 'architecture/sequence/state mermaid diagrams and system figures',
    },
  },
  {
    id: 'life-science',
    name: { en: 'Botanica', ar: 'بوتانيكا' },
    description: {
      en: 'Soft, rounded deck for biology, medicine and health sciences.',
      ar: 'عرض ناعم بزوايا دائرية للأحياء والطب والعلوم الصحية.',
    },
    bestFor: ['biology', 'medicine', 'nursing', 'pharmacy', 'public health', 'environmental science'],
    themeId: 'botanica',
    style: {
      density: 'balanced',
      tone: 'clinical/scientific clarity; link structure to function',
      preferredLayouts: ['BULLETS', 'DEFINITION', 'TWO_COLUMN', 'QUOTE_CALLOUT'],
      visualEmphasis: 'labelled textbook figures first, process diagrams second',
    },
  },
  {
    id: 'modern-minimal',
    name: { en: 'Aurora', ar: 'الشفق' },
    description: {
      en: 'Gradient covers, big ideas, few words — business, management and design.',
      ar: 'أغلفة متدرجة وأفكار كبيرة بكلمات قليلة — للأعمال والإدارة والتصميم.',
    },
    bestFor: ['business', 'management', 'marketing', 'design', 'communication'],
    themeId: 'aurora',
    style: {
      density: 'light',
      tone: 'confident and concise; one idea per slide, real-world cases',
      preferredLayouts: ['QUOTE_CALLOUT', 'BULLETS', 'TWO_COLUMN'],
      visualEmphasis: 'frameworks as simple diagrams; plenty of whitespace',
    },
  },
  {
    id: 'workshop-interactive',
    name: { en: 'Sunrise Workshop', ar: 'ورشة الشروق' },
    description: {
      en: 'Warm, playful activity session: checkpoints, exercises and discussions.',
      ar: 'جلسة أنشطة دافئة ومرحة: نقاط تحقق وتمارين ونقاشات.',
    },
    bestFor: ['labs', 'skills courses', 'practical sessions', 'first-year courses'],
    themeId: 'sunrise',
    style: {
      density: 'light',
      tone: 'engaging and hands-on; address students directly',
      preferredLayouts: ['QUOTE_CALLOUT', 'EXAMPLE_STEPS', 'BULLETS'],
      visualEmphasis: 'a checkpoint or activity every 3–4 slides; simple process diagrams',
    },
  },
  {
    id: 'swiss-minimal',
    name: { en: 'Swiss Minimal', ar: 'السويسري البسيط' },
    description: {
      en: 'Bold typography on white with a single red accent — crisp and timeless.',
      ar: 'طباعة جريئة على خلفية بيضاء مع لون أحمر واحد — واضح وخالد.',
    },
    bestFor: ['architecture', 'design', 'arts', 'media', 'philosophy'],
    themeId: 'swiss',
    style: {
      density: 'light',
      tone: 'clear and assertive; short statements, strong hierarchy',
      preferredLayouts: ['BULLETS', 'QUOTE_CALLOUT', 'TWO_COLUMN'],
      visualEmphasis: 'few, large visuals; generous whitespace',
    },
  },
  {
    id: 'editorial-serif',
    name: { en: 'Editorial', ar: 'التحريري' },
    description: {
      en: 'Magazine-style warm paper, serif headlines and pull quotes.',
      ar: 'أسلوب مجلة بورق دافئ وعناوين مذيّلة واقتباسات بارزة.',
    },
    bestFor: ['literature', 'history', 'languages', 'law', 'political science'],
    themeId: 'editorial',
    style: {
      density: 'balanced',
      tone: 'narrative and reflective; connect ideas to sources and context',
      preferredLayouts: ['QUOTE_CALLOUT', 'BULLETS', 'DEFINITION', 'TWO_COLUMN'],
      visualEmphasis: 'primary sources, quotes and timelines',
    },
  },
  {
    id: 'corporate-pro',
    name: { en: 'Slate Pro', ar: 'سليت برو' },
    description: {
      en: 'Clean corporate deck with split covers, data tables and comparisons.',
      ar: 'عرض مؤسسي نظيف بأغلفة مقسومة وجداول بيانات ومقارنات.',
    },
    bestFor: ['accounting', 'finance', 'economics', 'management', 'information systems'],
    themeId: 'slate',
    style: {
      density: 'balanced',
      tone: 'executive and data-driven; quantify claims and compare options',
      preferredLayouts: ['TWO_COLUMN', 'BULLETS', 'EXAMPLE_STEPS', 'DEFINITION'],
      visualEmphasis: 'comparison tables and simple flow diagrams',
    },
  },
];

export const DEFAULT_TEMPLATE_ID = 'academic-classic';

const CUSTOM_PREFIX = 'custom-';

const DEFAULT_CUSTOM_STYLE: SlideTemplateStyle = {
  density: 'balanced',
  tone: 'clear academic voice matching the institution brand',
  preferredLayouts: ['BULLETS', 'TWO_COLUMN', 'DEFINITION', 'EXAMPLE_STEPS'],
  visualEmphasis: 'balanced mix of figures and simple diagrams',
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
