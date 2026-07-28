/**
 * GradX in-system university slide deck pipeline helpers.
 *
 * Architecture (lecture → teachable PPTX):
 * 1. Source of truth: completed lecture JSON (modules, examples, checks).
 * 2. AI (OpenRouter + SLIDES_PROMPT) emits a pedagogical deck JSON.
 * 3. normalizeAndPaginateSlideDeck enforces classroom constraints:
 *    one idea / slide, max bullets, split long examples, renumber,
 *    and repairs empty bodies when the model returns title-only slides.
 * 4. Frontend buildUniversityPptx maps layouts → professional PPTX.
 *
 * External slide APIs (e.g. Skywork) are not used for new generations.
 */

export type SlideDeckSlide = {
  slideNumber?: number;
  type?: string;
  layout?: string;
  title?: string;
  subtitle?: string | null;
  sectionLabel?: string | null;
  bullets?: string[];
  leftColumn?: { heading?: string; bullets?: string[] } | null;
  rightColumn?: { heading?: string; bullets?: string[] } | null;
  callout?: { label?: string; text?: string } | null;
  formula?: { latex?: string; explanation?: string } | null;
  diagram?: { title?: string; mermaid?: string } | null;
  example?: {
    problem?: string;
    steps?: string[];
    solution?: string;
  } | null;
  table?: { headers?: string[]; rows?: string[][] } | null;
  cloCode?: string | null;
  bloomLevel?: string | null;
  teachingBeat?: string | null;
  timingMinutes?: number | null;
  speakerNotes?: string | null;
  [key: string]: unknown;
};

export type SlideDeck = {
  source?: string;
  provider?: string;
  deckMeta?: Record<string, unknown>;
  totalSlides?: number;
  slides?: SlideDeckSlide[];
  streamStatus?: string;
  [key: string]: unknown;
};

const MAX_BULLETS = 5;
const MAX_BULLET_WORDS = 18;
const MAX_EXAMPLE_STEPS_PER_SLIDE = 4;
const MAX_SPEAKER_NOTE_CHARS = 900;

const FILLER_BULLET_RE =
  /^(good\s+(morning|afternoon|evening)|hello(\s+everyone)?|welcome(\s+everyone)?|hi(\s+everyone)?|today[, ]|let'?s\s+(dive|embark|begin|start|discuss)|we\s+(will|are going to)\s+(now\s+)?(discuss|explore|look|cover)|this\s+is\s+(where|a critical|crucial)|as\s+we\s+(begin|start)|in\s+this\s+(lecture|section|module)\s+we)\b/i;

function isFillerBullet(text: string): boolean {
  const cleaned = text.replace(/\*\*/g, '').trim();
  if (!cleaned) return true;
  if (FILLER_BULLET_RE.test(cleaned)) return true;
  if (cleaned.length < 8 && /^(ok|okay|so|well|right)[.!]?$/i.test(cleaned)) {
    return true;
  }
  return false;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asText(value: unknown, fallback = ''): string {
  if (value == null) return fallback;
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => asText(item))
      .filter(Boolean)
      .join(' ')
      .trim() || fallback;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of [
      'text',
      'content',
      'value',
      'label',
      'title',
      'bullet',
      'point',
      'html',
    ]) {
      const nested = asText(obj[key]);
      if (nested) return nested;
    }
  }
  return fallback;
}

function trimWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text;
  return `${words.slice(0, maxWords).join(' ')}…`;
}

function normalizeBullets(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(/\n+|•|^\s*[-*]\s+/m)
      .map((item) => trimWords(asText(item), MAX_BULLET_WORDS))
      .filter((item) => item && !isFillerBullet(item))
      .slice(0, MAX_BULLETS);
  }

  return asArray<unknown>(value)
    .map((item) => trimWords(asText(item), MAX_BULLET_WORDS))
    .filter((item) => item && !isFillerBullet(item))
    .slice(0, MAX_BULLETS);
}

function bulletsFromNotes(notes: string): string[] {
  const cleaned = asText(notes);
  if (!cleaned) return [];

  const byBreak = cleaned
    .split(/\n+|•|(?<=[.!?])\s+(?=[A-ZÀ-ÖØ-Þ\u0600-\u06FF])/)
    .map((part) => asText(part))
    .filter((part) => part.length >= 12);

  if (byBreak.length >= 2) {
    return byBreak.slice(0, MAX_BULLETS).map((b) => trimWords(b, MAX_BULLET_WORDS));
  }

  return [trimWords(cleaned, MAX_BULLET_WORDS)];
}

function defaultLayoutForType(type: string): string {
  switch (type) {
    case 'TITLE':
      return 'TITLE_CENTER';
    case 'SECTION':
      return 'SECTION_DIVIDER';
    case 'DEFINITION':
      return 'DEFINITION';
    case 'FORMULA':
      return 'FORMULA_FOCUS';
    case 'EXAMPLE':
      return 'EXAMPLE_STEPS';
    case 'COMPARISON':
      return 'TWO_COLUMN';
    case 'CHECKPOINT':
    case 'ACTIVITY':
      return 'QUOTE_CALLOUT';
    default:
      return 'BULLETS';
  }
}

function canonicalizeTypeAndLayout(
  rawType: string,
  rawLayout: string,
): { type: string; layout: string } {
  let type = rawType || 'CONTENT';
  let layout = rawLayout;

  const typeAliases: Record<string, string> = {
    TITLE_CENTER: 'TITLE',
    SECTION_DIVIDER: 'SECTION',
    SECTION_BREAK: 'SECTION',
    LEARNING_OUTCOME: 'LEARNING_OUTCOMES',
    OUTCOMES: 'LEARNING_OUTCOMES',
    NEXT_STEP: 'NEXT_STEPS',
    REFERENCE: 'REFERENCES',
    QUIZ: 'CHECKPOINT',
    CHECK: 'CHECKPOINT',
  };
  type = typeAliases[type] || type;

  const layoutAliases: Record<string, string> = {
    TITLE: 'TITLE_CENTER',
    SECTION: 'SECTION_DIVIDER',
    DIVIDER: 'SECTION_DIVIDER',
    BULLET: 'BULLETS',
    TWO_COLUMNS: 'TWO_COLUMN',
    COLUMNS: 'TWO_COLUMN',
    QUOTE: 'QUOTE_CALLOUT',
    CALLOUT: 'QUOTE_CALLOUT',
    FORMULA: 'FORMULA_FOCUS',
    EXAMPLE: 'EXAMPLE_STEPS',
    STEPS: 'EXAMPLE_STEPS',
  };
  layout = layoutAliases[layout] || layout;

  if (!layout) {
    layout = defaultLayoutForType(type);
  }

  // Structural types always own their layout even if the model mis-tagged it.
  if (type === 'TITLE') layout = 'TITLE_CENTER';
  if (type === 'SECTION') layout = 'SECTION_DIVIDER';
  if (type === 'EXAMPLE' && layout === 'BULLETS') layout = 'EXAMPLE_STEPS';
  if (
    (type === 'CHECKPOINT' || type === 'ACTIVITY') &&
    layout === 'BULLETS'
  ) {
    layout = 'QUOTE_CALLOUT';
  }
  if (type === 'DEFINITION' && layout === 'BULLETS') layout = 'DEFINITION';
  if (type === 'FORMULA' && layout === 'BULLETS') layout = 'FORMULA_FOCUS';
  if (type === 'COMPARISON' && layout === 'BULLETS') layout = 'TWO_COLUMN';

  return { type, layout };
}

function cloneSlide(slide: SlideDeckSlide): SlideDeckSlide {
  return JSON.parse(JSON.stringify(slide)) as SlideDeckSlide;
}

function splitExampleSlide(slide: SlideDeckSlide): SlideDeckSlide[] {
  const steps = asArray<string>(slide.example?.steps)
    .map((step) => asText(step))
    .filter(Boolean);

  if (steps.length <= MAX_EXAMPLE_STEPS_PER_SLIDE) {
    return [slide];
  }

  const chunks: string[][] = [];
  for (let i = 0; i < steps.length; i += MAX_EXAMPLE_STEPS_PER_SLIDE) {
    chunks.push(steps.slice(i, i + MAX_EXAMPLE_STEPS_PER_SLIDE));
  }

  return chunks.map((chunk, index) => {
    const part = cloneSlide(slide);
    const isLast = index === chunks.length - 1;
    part.title =
      chunks.length > 1
        ? `${asText(slide.title, 'Worked Example')} (${index + 1}/${chunks.length})`
        : asText(slide.title, 'Worked Example');
    part.example = {
      problem: index === 0 ? asText(slide.example?.problem) : '',
      steps: chunk,
      solution: isLast ? asText(slide.example?.solution) : '',
    };
    part.bullets = normalizeBullets(part.bullets);
    part.layout = 'EXAMPLE_STEPS';
    part.type = 'EXAMPLE';
    return part;
  });
}

function splitBulletSlide(slide: SlideDeckSlide): SlideDeckSlide[] {
  const bullets = normalizeBullets(
    asArray<string>(slide.bullets).length
      ? slide.bullets
      : [
          ...asArray<string>(slide.leftColumn?.bullets),
          ...asArray<string>(slide.rightColumn?.bullets),
        ],
  );

  if (bullets.length <= MAX_BULLETS) {
    slide.bullets = bullets;
    return [slide];
  }

  const chunks: string[][] = [];
  for (let i = 0; i < bullets.length; i += MAX_BULLETS) {
    chunks.push(bullets.slice(i, i + MAX_BULLETS));
  }

  return chunks.map((chunk, index) => {
    const part = cloneSlide(slide);
    part.title =
      chunks.length > 1
        ? `${asText(slide.title, 'Content')} (${index + 1}/${chunks.length})`
        : asText(slide.title, 'Content');
    part.bullets = chunk;
    part.leftColumn = null;
    part.rightColumn = null;
    part.layout = part.layout || 'BULLETS';
    return part;
  });
}

function slideHasBody(slide: SlideDeckSlide): boolean {
  if (normalizeBullets(slide.bullets).length > 0) return true;
  if (asText(slide.callout?.text)) return true;
  if (asText(slide.formula?.latex) || asText(slide.formula?.explanation)) {
    return true;
  }
  if (
    asText(slide.example?.problem) ||
    asArray(slide.example?.steps).length > 0 ||
    asText(slide.example?.solution)
  ) {
    return true;
  }
  if (
    normalizeBullets(slide.leftColumn?.bullets).length > 0 ||
    normalizeBullets(slide.rightColumn?.bullets).length > 0
  ) {
    return true;
  }
  if (asArray((slide.table as any)?.headers).length > 0) return true;
  if (asText(slide.diagram?.mermaid)) return true;
  return false;
}

function isStructuralSlide(type: string, layout: string): boolean {
  return (
    type === 'TITLE' ||
    type === 'SECTION' ||
    layout === 'TITLE_CENTER' ||
    layout === 'SECTION_DIVIDER'
  );
}

/**
 * Repair title-only slides the model often emits (empty bullets/callout/example).
 */
function repairEmptySlideBody(slide: SlideDeckSlide): SlideDeckSlide {
  if (isStructuralSlide(slide.type || '', slide.layout || '')) {
    return slide;
  }
  if (slideHasBody(slide)) return slide;

  const notes = asText(slide.speakerNotes);
  const noteBullets = bulletsFromNotes(notes);
  const title = asText(slide.title, 'Content');
  const type = asText(slide.type, 'CONTENT').toUpperCase();
  const layout = asText(slide.layout).toUpperCase();

  if (type === 'EXAMPLE' || layout === 'EXAMPLE_STEPS') {
    slide.example = {
      problem: noteBullets[0] || `Worked example: ${title}`,
      steps:
        noteBullets.length > 1
          ? noteBullets.slice(1)
          : [
              'State known values and objective.',
              'Apply the method step by step.',
              'Interpret the result and check assumptions.',
            ],
      solution: notes || `Solve using ${title}.`,
    };
    slide.layout = 'EXAMPLE_STEPS';
    slide.type = 'EXAMPLE';
    return slide;
  }

  if (
    type === 'CHECKPOINT' ||
    type === 'ACTIVITY' ||
    layout === 'QUOTE_CALLOUT'
  ) {
    slide.callout = {
      label: type === 'ACTIVITY' ? 'Activity' : 'Checkpoint',
      text:
        noteBullets[0] ||
        notes ||
        `Discuss: what is the key idea behind “${title}”, and when does it fail?`,
    };
    if (noteBullets.length > 1) {
      slide.bullets = noteBullets.slice(1, MAX_BULLETS);
    }
    slide.layout = 'QUOTE_CALLOUT';
    return slide;
  }

  if (type === 'DEFINITION' || layout === 'DEFINITION') {
    slide.callout = {
      label: 'Definition',
      text: noteBullets[0] || notes || `Define and interpret: ${title}.`,
    };
    if (noteBullets.length > 1) {
      slide.bullets = noteBullets.slice(1, MAX_BULLETS);
    }
    slide.layout = 'DEFINITION';
    return slide;
  }

  if (type === 'FORMULA' || layout === 'FORMULA_FOCUS') {
    slide.formula = {
      latex: title,
      explanation:
        noteBullets[0] || notes || `Explain the meaning and use of ${title}.`,
    };
    slide.layout = 'FORMULA_FOCUS';
    return slide;
  }

  slide.bullets =
    noteBullets.length > 0
      ? noteBullets
      : [
          `Core idea: ${title}`,
          'State assumptions and when the method applies.',
          'Note limitations and common pitfalls.',
        ];
  slide.layout = slide.layout || 'BULLETS';
  return slide;
}

function normalizeOneSlide(raw: unknown): SlideDeckSlide | null {
  if (!raw || typeof raw !== 'object') return null;
  const slide = raw as SlideDeckSlide;
  const title = asText(slide.title || (slide as any).heading);
  if (!title) return null;

  const { type, layout } = canonicalizeTypeAndLayout(
    asText(slide.type, 'CONTENT').toUpperCase(),
    asText(slide.layout).toUpperCase(),
  );

  let bullets = normalizeBullets(
    slide.bullets ?? (slide as any).points ?? (slide as any).content,
  );

  let callout = slide.callout
    ? {
        label: asText(slide.callout.label, 'Note'),
        text: asText(slide.callout.text),
      }
    : null;
  if (callout && !callout.text) callout = null;
  // Model sometimes returns callout as a plain string
  if (!callout && typeof (slide as any).callout === 'string') {
    const text = asText((slide as any).callout);
    if (text) callout = { label: 'Note', text };
  }

  let example = slide.example
    ? {
        problem: asText(slide.example.problem),
        steps: asArray<unknown>(slide.example.steps)
          .map((step) => asText(step))
          .filter(Boolean),
        solution: asText(slide.example.solution),
      }
    : null;
  if (
    example &&
    !example.problem &&
    example.steps.length === 0 &&
    !example.solution
  ) {
    example = null;
  }

  // Promote bullets into typed bodies when the model used the wrong field.
  if (!example && (type === 'EXAMPLE' || layout === 'EXAMPLE_STEPS') && bullets.length) {
    example = {
      problem: bullets[0],
      steps: bullets.slice(1),
      solution: '',
    };
  }
  if (
    !callout &&
    (type === 'CHECKPOINT' ||
      type === 'ACTIVITY' ||
      type === 'DEFINITION' ||
      layout === 'QUOTE_CALLOUT' ||
      layout === 'DEFINITION') &&
    bullets.length
  ) {
    callout = {
      label:
        type === 'DEFINITION' || layout === 'DEFINITION'
          ? 'Definition'
          : type === 'ACTIVITY'
            ? 'Activity'
            : 'Checkpoint',
      text: bullets.join(' '),
    };
    bullets = [];
  }

  let normalized: SlideDeckSlide = {
    ...slide,
    type,
    layout,
    title,
    subtitle: asText(slide.subtitle) || null,
    sectionLabel: asText(slide.sectionLabel) || null,
    bullets,
    leftColumn: slide.leftColumn
      ? {
          heading: asText(slide.leftColumn.heading),
          bullets: normalizeBullets(slide.leftColumn.bullets),
        }
      : null,
    rightColumn: slide.rightColumn
      ? {
          heading: asText(slide.rightColumn.heading),
          bullets: normalizeBullets(slide.rightColumn.bullets),
        }
      : null,
    callout,
    formula: slide.formula
      ? {
          latex: asText(slide.formula.latex),
          explanation: asText(slide.formula.explanation),
        }
      : null,
    diagram: slide.diagram
      ? {
          title: asText(slide.diagram.title),
          mermaid: asText(slide.diagram.mermaid),
        }
      : null,
    example,
    cloCode: asText(slide.cloCode) || null,
    bloomLevel: asText(slide.bloomLevel) || null,
    teachingBeat: asText(slide.teachingBeat) || null,
    timingMinutes:
      typeof slide.timingMinutes === 'number' &&
      Number.isFinite(slide.timingMinutes)
        ? slide.timingMinutes
        : null,
    speakerNotes: asText(slide.speakerNotes).slice(0, MAX_SPEAKER_NOTE_CHARS),
  };

  normalized = repairEmptySlideBody(normalized);
  return normalized;
}

/**
 * Enforce professional classroom pagination on an AI-produced deck.
 */
export function normalizeAndPaginateSlideDeck(
  raw: unknown,
  context?: {
    courseTitle?: string;
    topicTitle?: string;
    topicNumber?: number;
  },
): SlideDeck {
  const input =
    raw && typeof raw === 'object' ? (raw as SlideDeck) : ({} as SlideDeck);
  const incomingSlides = asArray<unknown>(input.slides);

  const expanded: SlideDeckSlide[] = [];
  for (const item of incomingSlides) {
    const normalized = normalizeOneSlide(item);
    if (!normalized) continue;

    if (normalized.type === 'EXAMPLE' || normalized.layout === 'EXAMPLE_STEPS') {
      expanded.push(...splitExampleSlide(normalized));
      continue;
    }

    if (
      normalized.type === 'CONTENT' ||
      normalized.type === 'AGENDA' ||
      normalized.type === 'LEARNING_OUTCOMES' ||
      normalized.type === 'SUMMARY' ||
      normalized.type === 'NEXT_STEPS' ||
      normalized.layout === 'BULLETS'
    ) {
      expanded.push(...splitBulletSlide(normalized));
      continue;
    }

    expanded.push(normalized);
  }

  const slides = expanded.map((slide, index) => ({
    ...slide,
    slideNumber: index + 1,
  }));

  const deckMeta = {
    ...(input.deckMeta && typeof input.deckMeta === 'object'
      ? input.deckMeta
      : {}),
    courseTitle:
      asText(input.deckMeta?.courseTitle) ||
      asText(context?.courseTitle) ||
      'Course',
    topicTitle:
      asText(input.deckMeta?.topicTitle) ||
      asText(context?.topicTitle) ||
      'Topic',
    topicNumber:
      Number(input.deckMeta?.topicNumber) ||
      Number(context?.topicNumber) ||
      1,
    designTheme: asText(input.deckMeta?.designTheme, 'UNIVERSITY_ACADEMIC'),
  };

  return {
    source: 'gradx',
    provider: 'openrouter',
    deckMeta,
    totalSlides: slides.length,
    slides,
    streamStatus: 'done',
    generatedAt: new Date().toISOString(),
  };
}

export function parseSlidesLength(value: unknown, fallback = 16): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  const match = String(value ?? '').match(/(\d+)/);
  if (!match) return fallback;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function resolveSlideBudget(
  slidesLength: unknown,
  moduleCount: number,
): {
  target: number;
  opening: number;
  closing: number;
  perModule: number;
  /** Extra slides to sprinkle across the first N modules so totals hit target. */
  remainder: number;
} {
  const target = Math.min(36, Math.max(6, parseSlidesLength(slidesLength, 16)));
  const modules = Math.max(1, moduleCount);
  const opening = target <= 10 ? 2 : 3;
  const closing =
    target <= 10 ? 2 : Math.min(3, Math.max(2, Math.round(target * 0.12)));
  const bodySlots = Math.max(modules, target - opening - closing);
  const perModule = Math.max(1, Math.floor(bodySlots / modules));
  const remainder = Math.max(0, bodySlots - perModule * modules);
  return { target, opening, closing, perModule, remainder };
}

function slideKeepPriority(slide: SlideDeckSlide, index: number): number {
  const type = asText(slide.type).toUpperCase();
  const layout = asText(slide.layout).toUpperCase();
  if (type === 'TITLE' || layout === 'TITLE_CENTER' || index === 0) return 1000;
  if (type === 'LEARNING_OUTCOMES') return 900;
  if (type === 'AGENDA') return 850;
  if (type === 'SUMMARY') return 800;
  if (type === 'NEXT_STEPS') return 750;
  if (type === 'SECTION' || layout === 'SECTION_DIVIDER') return 700;
  if (type === 'EXAMPLE' || layout === 'EXAMPLE_STEPS') return 650;
  if (type === 'DEFINITION' || layout === 'DEFINITION') return 620;
  if (type === 'FORMULA' || layout === 'FORMULA_FOCUS') return 610;
  if (type === 'CHECKPOINT' || type === 'ACTIVITY') return 580;
  if (type === 'COMPARISON') return 560;
  if (type === 'REFERENCES') return 200;
  // Prefer keeping earlier teaching content over later filler.
  return 400 - Math.min(index, 200);
}

/**
 * Force the deck to the requested Slides Length count.
 * Trims lowest-priority slides when over; leaves under-count as-is
 * (generation prompts are responsible for filling up to target).
 */
export function fitSlideDeckToTarget(
  deck: SlideDeck,
  targetRaw: unknown,
): SlideDeck {
  const target = parseSlidesLength(targetRaw, deck.slides?.length || 16);
  const slides = asArray<SlideDeckSlide>(deck.slides);
  if (!slides.length || slides.length === target) {
    return {
      ...deck,
      totalSlides: slides.length,
      slides: slides.map((slide, index) => ({
        ...slide,
        slideNumber: index + 1,
      })),
    };
  }

  let next = slides;
  if (slides.length > target) {
    const ranked = slides.map((slide, index) => ({
      slide,
      index,
      priority: slideKeepPriority(slide, index),
    }));
    // Drop lowest priority first; on ties drop later slides.
    ranked.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return b.index - a.index;
    });
    const dropCount = slides.length - target;
    const dropIndexes = new Set(
      ranked.slice(0, dropCount).map((item) => item.index),
    );
    next = slides.filter((_, index) => !dropIndexes.has(index));
  }

  const fitted = next.map((slide, index) => ({
    ...slide,
    slideNumber: index + 1,
  }));

  return {
    ...deck,
    totalSlides: fitted.length,
    slides: fitted,
    deckMeta: {
      ...(deck.deckMeta && typeof deck.deckMeta === 'object' ? deck.deckMeta : {}),
      targetSlideCount: target,
    },
  };
}

/**
 * Compact lecture JSON so the slides prompt stays within model context.
 */
export function compactLectureForSlides(
  lecture: unknown,
  maxChars = 42000,
): unknown {
  if (!lecture || typeof lecture !== 'object') return lecture ?? {};
  const raw = JSON.stringify(lecture);
  if (raw.length <= maxChars) return lecture;

  const source = lecture as Record<string, any>;
  const modules = asArray<Record<string, any>>(source.modules).map(
    (module, index) => ({
      moduleIndex: module.moduleIndex ?? index + 1,
      title: module.title,
      associatedCloIds: module.associatedCloIds,
      targetedBloomsLevels: module.targetedBloomsLevels,
      theoreticalFoundations: {
        formalDefinition:
          module.theoreticalFoundations?.formalDefinition ?? null,
        structuralInterpretation:
          module.theoreticalFoundations?.structuralInterpretation ?? null,
      },
      algorithmicOrProcessBreakdown: {
        stepByStepExecution: asArray(
          module.algorithmicOrProcessBreakdown?.stepByStepExecution,
        ).slice(0, 8),
        edgeCasesAndFailureModes:
          module.algorithmicOrProcessBreakdown?.edgeCasesAndFailureModes ??
          null,
      },
      appliedDemonstrations: asArray(module.appliedDemonstrations)
        .slice(0, 2)
        .map((demo: any) => ({
          caseStudyTitle: demo?.caseStudyTitle,
          concreteProblemStatement: demo?.concreteProblemStatement,
          stepByStepSolution: asText(demo?.stepByStepSolution).slice(0, 1200),
          executableArtifactSnippet: asText(
            demo?.executableArtifactSnippet,
          ).slice(0, 800),
        })),
      formativeChecks: asArray(module.formativeChecks).slice(0, 2),
      moduleKeyTakeaways: asArray(module.moduleKeyTakeaways).slice(0, 5),
      professorSpeakingNotes: asArray(module.professorSpeakingNotes).slice(
        0,
        4,
      ),
    }),
  );

  const compact = {
    metadata: source.metadata ?? null,
    lectureOverview: source.lectureOverview ?? null,
    modules,
    comprehensiveAssessment: asArray(source.comprehensiveAssessment).slice(
      0,
      4,
    ),
    providedReferences: asArray(source.providedReferences).slice(0, 8),
  };

  const compactRaw = JSON.stringify(compact);
  if (compactRaw.length <= maxChars) return compact;

  return {
    ...compact,
    modules: modules.slice(0, 4),
  };
}
