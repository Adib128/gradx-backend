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

const FRAME_PHASES = new Set<LecturePhase>([
  'title',
  'clo_scope',
  'roadmap',
  'introduction',
  'summary',
  'knowledge_check',
  'references',
]);

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

/**
 * Ensure the plan has the PO lecture arc: title → clo_scope → roadmap →
 * introduction → body… → summary → knowledge_check → references.
 * Existing body sections are preserved; missing frame sections are inserted.
 */
export function ensureLectureArc(
  plan: StudioPlan,
  options: { language: 'ar' | 'en'; hasReferences: boolean },
): StudioPlan {
  const ar = options.language === 'ar';
  const sections = plan.sections.map((section) => ({ ...section }));
  const byPhase = (phase: LecturePhase) => sections.filter((section) => section.phase === phase);
  const body = sections.filter((section) => !FRAME_PHASES.has(section.phase) || section.phase === 'body');

  const ordered: StudioPlanSection[] = [];
  const pushUnique = (phase: LecturePhase, factory: () => StudioPlanSection) => {
    const existing = byPhase(phase)[0];
    ordered.push(existing ? { ...existing, phase } : factory());
  };

  pushUnique('title', () =>
    frameSection(
      'title',
      ar ? 'شريحة العنوان' : 'Lecture title',
      ar ? 'بيانات المقرر والمحاضرة' : 'Course and lecture identity from course data',
      1,
      ordered.length,
    ),
  );
  pushUnique('clo_scope', () =>
    frameSection(
      'clo_scope',
      ar ? 'مخرج التعلم ونطاق المحاضرة' : 'CLO and lecture scope',
      ar
        ? 'عرض مخرج التعلم كاملاً وما يُغطى / لا يُغطى في هذه المحاضرة'
        : 'Full CLO plus covered / partial / not covered for this lecture',
      1,
      ordered.length,
    ),
  );
  pushUnique('roadmap', () =>
    frameSection(
      'roadmap',
      ar ? 'خريطة المحاضرة' : 'Lecture roadmap',
      ar ? 'ترتيب المواضيع المستند إلى الفصل' : 'Teaching order grounded in the chapter',
      1,
      ordered.length,
    ),
  );
  pushUnique('introduction', () =>
    frameSection(
      'introduction',
      ar ? 'مقدمة' : 'Introduction',
      ar ? 'سياق وأهمية وسؤال محفّز' : 'Context, importance, motivating question',
      1,
      ordered.length,
    ),
  );

  const bodySections = (body.length ? body : sections.filter((s) => s.phase === 'body')).map(
    (section) => ({ ...section, phase: 'body' as const }),
  );
  if (!bodySections.length) {
    ordered.push(
      frameSection(
        'body',
        plan.title || (ar ? 'المحتوى الرئيسي' : 'Main content'),
        plan.approach || (ar ? 'شرح مفاهيم المحاضرة' : 'Teach the lecture concepts'),
        Math.max(2, Math.floor((plan.sections[0]?.slideCount ?? 6) / 2)),
        ordered.length,
      ),
    );
  } else {
    ordered.push(...bodySections);
  }

  pushUnique('summary', () =>
    frameSection(
      'summary',
      ar ? 'خلاصة المحاضرة' : 'Lecture summary',
      ar
        ? 'أبرز النقاط وربطها بمكوّنات مخرج التعلم المغطاة فقط'
        : 'Key takeaways linked only to CLO parts covered in this lecture',
      1,
      ordered.length,
    ),
  );
  pushUnique('knowledge_check', () =>
    frameSection(
      'knowledge_check',
      ar ? 'تحقق من الفهم' : 'Knowledge check',
      ar
        ? 'اختبر فهمك: 3–5 أسئلة على المحتوى الذي دُرّس فقط'
        : 'Check your understanding: 3–5 questions only on content taught in this lecture',
      1,
      ordered.length,
    ),
  );
  // Always close with References (Clause-style), even when chapter excerpts are sparse.
  pushUnique('references', () =>
    frameSection(
      'references',
      ar ? 'المراجع' : 'References',
      ar ? 'مراجع الفصل ومصادر الأشكال' : 'Chapter bibliography and figure provenance',
      1,
      ordered.length,
    ),
  );
  void options.hasReferences;

  return {
    ...plan,
    sections: ordered.map((section, index) => ({ ...section, id: `s${index + 1}` })),
  };
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
    'LEARNING_OUTCOMES',
    'AGENDA',
    'INTRODUCTION',
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
