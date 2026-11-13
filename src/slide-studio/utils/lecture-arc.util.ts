import type {
  LecturePhase,
  StudioCloComponent,
  StudioOutlineItem,
  StudioPlan,
  StudioPlanSection,
} from '../slide-studio.types';

export const LECTURE_PHASES: LecturePhase[] = [
  'title',
  'clo_scope',
  'roadmap',
  'introduction',
  'body',
  'summary',
  'knowledge_check',
  'references',
];

const PHASE_OF: Record<string, LecturePhase> = {
  title: 'title',
  clo_scope: 'clo_scope',
  closcope: 'clo_scope',
  clo: 'clo_scope',
  roadmap: 'roadmap',
  agenda: 'roadmap',
  overview: 'roadmap',
  introduction: 'introduction',
  intro: 'introduction',
  body: 'body',
  core: 'body',
  content: 'body',
  summary: 'summary',
  conclusion: 'summary',
  knowledge_check: 'knowledge_check',
  knowledgecheck: 'knowledge_check',
  checkpoint: 'knowledge_check',
  assessment: 'knowledge_check',
  references: 'references',
  refs: 'references',
};

export function parseLecturePhase(raw: unknown, fallback: LecturePhase = 'body'): LecturePhase {
  if (typeof raw !== 'string') return fallback;
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return PHASE_OF[key] ?? fallback;
}

/**
 * Chrome slides excluded from the instructor "content slides" parameter:
 * title cover, key takeaways, knowledge check, references.
 * Example: parameter 10 → 1 title + 10 content + takeaways + check + references = 14.
 */
export const FIXED_CHROME_PHASES: LecturePhase[] = [
  'title',
  'summary',
  'knowledge_check',
  'references',
];

export const FIXED_CHROME_SLIDES = FIXED_CHROME_PHASES.length;

const FRAME_PHASES = new Set<LecturePhase>([
  'title',
  'clo_scope',
  'roadmap',
  'introduction',
  'summary',
  'knowledge_check',
  'references',
]);

export function isFixedChromePhase(phase: LecturePhase): boolean {
  return FIXED_CHROME_PHASES.includes(phase);
}

/** Total deck size from the instructor content-slide parameter. */
export function deckTotalFromContentSlides(contentSlides: number): number {
  return Math.max(1, Math.floor(contentSlides) || 1) + FIXED_CHROME_SLIDES;
}

function frameSection(
  phase: LecturePhase,
  title: string,
  goal: string,
  slideCount: number,
  index: number,
): StudioPlanSection {
  return {
    id: `s${index + 1}`,
    title,
    goal,
    cloCodes: [],
    slideCount,
    keyPoints: [],
    visuals: [],
    phase,
  };
}

function mergeBodySections(sections: StudioPlanSection[], maxBody: number): StudioPlanSection[] {
  if (sections.length <= maxBody) return sections;
  const keep = sections.slice(0, Math.max(1, maxBody));
  const overflow = sections.slice(keep.length);
  const last = keep[keep.length - 1];
  keep[keep.length - 1] = {
    ...last,
    slideCount:
      last.slideCount +
      overflow.reduce((sum, section) => sum + section.slideCount, 0),
    keyPoints: [...last.keyPoints, ...overflow.flatMap((section) => section.keyPoints)].slice(
      0,
      8,
    ),
    cloCodes: [...new Set([...last.cloCodes, ...overflow.flatMap((section) => section.cloCodes)])],
    visuals: [...last.visuals, ...overflow.flatMap((section) => section.visuals)].slice(0, 6),
  };
  return keep;
}

/** Rebalance only non-chrome sections so their slideCounts sum to `contentSlides`. */
export function rebalanceContentSlides(plan: StudioPlan, contentSlides: number): StudioPlan {
  const target = Math.max(1, Math.floor(contentSlides) || 1);
  const chrome = plan.sections.filter((section) => isFixedChromePhase(section.phase));
  const content = plan.sections
    .filter((section) => !isFixedChromePhase(section.phase))
    .map((section) => ({ ...section }));
  if (!content.length) {
    content.push(
      frameSection('body', plan.title || 'Main content', plan.approach || 'Teach the topic', target, chrome.length),
    );
  }
  let total = content.reduce((sum, section) => sum + section.slideCount, 0);
  while (total > target) {
    const largest = content.reduce((best, section) =>
      section.slideCount > best.slideCount ? section : best,
    );
    if (largest.slideCount <= 1) break;
    largest.slideCount -= 1;
    total -= 1;
  }
  let cursor = 0;
  while (total < target) {
    const candidates = [...content].sort((a, b) => a.slideCount - b.slideCount);
    candidates[cursor % candidates.length].slideCount += 1;
    cursor += 1;
    total += 1;
  }
  // Preserve teaching order: title → content… → summary → knowledge_check → references
  const title = chrome.filter((section) => section.phase === 'title');
  const closing = chrome.filter((section) => section.phase !== 'title');
  return {
    ...plan,
    sections: [...title, ...content, ...closing].map((section, index) => ({
      ...section,
      id: `s${index + 1}`,
      slideCount: isFixedChromePhase(section.phase) ? 1 : section.slideCount,
    })),
  };
}

/**
 * Ensure the plan has title + content… + takeaways + knowledge check + references.
 * `contentSlideCount` is the instructor parameter (excludes chrome).
 */
export function ensureLectureArc(
  plan: StudioPlan,
  options: {
    language: 'ar' | 'en';
    hasReferences: boolean;
    /** Instructor content-slide parameter (not including title/takeaways/check/refs). */
    slideCount?: number;
    /** @deprecated alias of slideCount */
    contentSlideCount?: number;
  },
): StudioPlan {
  const ar = options.language === 'ar';
  const contentTarget = Math.max(
    1,
    Math.floor(options.contentSlideCount ?? options.slideCount ?? 16) || 16,
  );
  const sections = plan.sections.map((section) => ({ ...section }));
  const byPhase = (phase: LecturePhase) =>
    sections.filter((section) => section.phase === phase);

  // Content = everything that is not fixed chrome (may include clo_scope / roadmap / intro / body).
  let contentSections: StudioPlanSection[] = sections
    .filter((section) => !isFixedChromePhase(section.phase))
    .map((section) => ({
      ...section,
      phase:
        section.phase === 'clo_scope' ||
        section.phase === 'roadmap' ||
        section.phase === 'introduction' ||
        section.phase === 'body'
          ? section.phase
          : ('body' as LecturePhase),
    }));

  if (!contentSections.length) {
    contentSections = [
      frameSection(
        'body',
        plan.title || (ar ? 'المحتوى الرئيسي' : 'Main content'),
        plan.approach || (ar ? 'شرح مفاهيم المحاضرة' : 'Teach the lecture concepts'),
        contentTarget,
        1,
      ),
    ];
  }

  // Keep enough content sections for the budget (at least 1, at most contentTarget).
  contentSections = mergeBodySections(contentSections, Math.min(contentTarget, 8));

  const title =
    byPhase('title')[0] ??
    frameSection(
      'title',
      ar ? 'شريحة العنوان' : 'Lecture title',
      ar ? 'بيانات المقرر والمحاضرة' : 'Course and lecture identity from course data',
      1,
      0,
    );
  const summary =
    byPhase('summary')[0] ??
    frameSection(
      'summary',
      ar ? 'خلاصة المحاضرة' : 'Key takeaways',
      ar
        ? 'أبرز النقاط وربطها بمكوّنات مخرج التعلم المغطاة فقط'
        : 'Key takeaways linked only to CLO parts covered in this lecture',
      1,
      0,
    );
  const knowledge =
    byPhase('knowledge_check')[0] ??
    frameSection(
      'knowledge_check',
      ar ? 'تحقق من الفهم' : 'Check your understanding',
      ar
        ? 'اختبر فهمك: 3–5 أسئلة على المحتوى الذي دُرّس فقط'
        : 'Check your understanding: 3–5 questions only on content taught in this lecture',
      1,
      0,
    );
  const references =
    byPhase('references')[0] ??
    frameSection(
      'references',
      ar ? 'المراجع' : 'References',
      ar ? 'مراجع الفصل ومصادر الأشكال' : 'Chapter bibliography and figure provenance',
      1,
      0,
    );
  void options.hasReferences;
  void FRAME_PHASES;

  const ordered: StudioPlanSection[] = [
    { ...title, phase: 'title', slideCount: 1 },
    ...contentSections,
    { ...summary, phase: 'summary', slideCount: 1 },
    { ...knowledge, phase: 'knowledge_check', slideCount: 1 },
    { ...references, phase: 'references', slideCount: 1 },
  ];

  return rebalanceContentSlides(
    {
      ...plan,
      sections: ordered.map((section, index) => ({ ...section, id: `s${index + 1}` })),
    },
    contentTarget,
  );
}

export function cloComponentsBlock(components: StudioCloComponent[] | undefined) {
  if (!components?.length) return '';
  return `CLO component map for THIS lecture (do not teach not_covered as if covered):
${components
  .map(
    (item) =>
      `- [${item.status}] ${item.cloCode} · ${item.label}${item.evidence ? ` — ${item.evidence}` : ''}`,
  )
  .join('\n')}`;
}

/** Preferred outline slide type for a plan section phase. */
export function outlineTypeForPhase(phase: LecturePhase): string {
  switch (phase) {
    case 'title':
      return 'TITLE';
    case 'clo_scope':
      return 'LEARNING_OUTCOMES';
    case 'roadmap':
      return 'AGENDA';
    case 'introduction':
      return 'INTRODUCTION';
    case 'summary':
      return 'SUMMARY';
    case 'knowledge_check':
      return 'CHECKPOINT';
    case 'references':
      return 'REFERENCES';
    default:
      return 'CONTENT';
  }
}

/** Soft check used by lint/QA: required arc types present in outline or slides. */
export function missingArcTypes(types: string[]): string[] {
  const upper = new Set(types.map((type) => type.toUpperCase()));
  const required = [
    'TITLE',
    'SUMMARY',
    'CHECKPOINT',
    'REFERENCES',
  ];
  return required.filter((type) => !upper.has(type) && !(type === 'SUMMARY' && upper.has('CONCLUSION')));
}

/** True when the last three types are Summary → Knowledge check → References. */
export function closingTriadGaps(types: string[]): string[] {
  if (types.length < 3) {
    return ['SUMMARY', 'CHECKPOINT', 'REFERENCES'];
  }
  const last = types.slice(-3).map((type) => type.toUpperCase());
  const gaps: string[] = [];
  if (last[0] !== 'SUMMARY' && last[0] !== 'CONCLUSION') gaps.push('SUMMARY');
  if (last[1] !== 'CHECKPOINT') gaps.push('CHECKPOINT');
  if (last[2] !== 'REFERENCES') gaps.push('REFERENCES');
  return gaps;
}

export function outlineHasPhaseTypes(outline: StudioOutlineItem[]) {
  return missingArcTypes(outline.map((item) => item.type));
}

/**
 * Force the last three outline slots to Summary → Knowledge check → References
 * so the writer always produces the Clause closing triad. Existing matching
 * slides are moved to the end rather than overwriting body content.
 */
export function ensureClosingOutline(
  outline: StudioOutlineItem[],
  plan: StudioPlan,
  language: 'ar' | 'en' = 'en',
): StudioOutlineItem[] {
  if (outline.length < 3) return outline;
  const ar = language === 'ar';
  const items = outline.map((item) => ({ ...item }));
  const sectionId = (phase: LecturePhase, fallback: string) =>
    plan.sections.find((section) => section.phase === phase)?.id ?? fallback;

  const takeLast = (...types: string[]) => {
    const match = new Set(types.map((type) => type.toUpperCase()));
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (match.has(String(items[i].type).toUpperCase())) {
        const [taken] = items.splice(i, 1);
        return taken;
      }
    }
    return null;
  };

  const asClosing = (
    item: StudioOutlineItem | null,
    type: string,
    title: string,
    intent: string,
    phase: LecturePhase,
    fallback: StudioOutlineItem,
  ): StudioOutlineItem => {
    const base = item ?? fallback;
    const already = item && String(item.type).toUpperCase() === type;
    return {
      ...base,
      type,
      layout: 'BULLETS',
      title: already && item.title ? item.title : title,
      intent: already && item.intent ? item.intent : intent,
      visual: { kind: 'none' },
      sectionId: sectionId(phase, base.sectionId),
    };
  };

  const refs = takeLast('REFERENCES');
  const check = takeLast('CHECKPOINT');
  const summary = takeLast('SUMMARY', 'CONCLUSION');
  const fallbackRefs = refs ?? items.pop()!;
  const fallbackCheck = check ?? items.pop()!;
  const fallbackSummary = summary ?? items.pop()!;

  return [
    ...items,
    asClosing(
      summary,
      'SUMMARY',
      ar ? 'خلاصة المحاضرة' : 'Lecture summary',
      ar
        ? 'أبرز النقاط وربطها بمكوّنات مخرج التعلم المغطاة فقط'
        : 'Key takeaways for CLO parts actually taught in this lecture',
      'summary',
      fallbackSummary,
    ),
    asClosing(
      check,
      'CHECKPOINT',
      ar ? 'تحقق من الفهم' : 'Knowledge check',
      ar
        ? 'اختبر فهمك: 3–5 أسئلة على المحتوى الذي دُرّس'
        : 'Check your understanding with 3–5 questions on taught content',
      'knowledge_check',
      fallbackCheck,
    ),
    asClosing(
      refs,
      'REFERENCES',
      ar ? 'المراجع' : 'References',
      ar ? 'مراجع الفصل ومصادر الأشكال' : 'Verified bibliography and figure provenance',
      'references',
      fallbackRefs,
    ),
  ].map((item, index) => ({ ...item, index }));
}
