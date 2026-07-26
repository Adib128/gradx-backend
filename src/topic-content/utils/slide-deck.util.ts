/**
 * GradX in-system university slide deck pipeline helpers.
 *
 * Architecture (lecture → teachable PPTX):
 * 1. Source of truth: completed lecture JSON (modules, examples, checks).
 * 2. AI (OpenRouter + SLIDES_PROMPT) emits a pedagogical deck JSON.
 * 3. normalizeAndPaginateSlideDeck enforces classroom constraints:
 *    one idea / slide, max bullets, split long examples, renumber.
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
const MAX_BULLET_WORDS = 16;
const MAX_EXAMPLE_STEPS_PER_SLIDE = 4;
const MAX_SPEAKER_NOTE_CHARS = 900;

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asText(value: unknown, fallback = ''): string {
  if (value == null) return fallback;
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return fallback;
}

function trimWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text;
  return `${words.slice(0, maxWords).join(' ')}…`;
}

function normalizeBullets(value: unknown): string[] {
  return asArray<unknown>(value)
    .map((item) => trimWords(asText(item), MAX_BULLET_WORDS))
    .filter(Boolean)
    .slice(0, MAX_BULLETS);
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

function normalizeOneSlide(raw: unknown): SlideDeckSlide | null {
  if (!raw || typeof raw !== 'object') return null;
  const slide = raw as SlideDeckSlide;
  const title = asText(slide.title);
  if (!title) return null;

  const type = asText(slide.type, 'CONTENT').toUpperCase();
  const layout =
    asText(slide.layout).toUpperCase() || defaultLayoutForType(type);

  const normalized: SlideDeckSlide = {
    ...slide,
    type,
    layout,
    title,
    subtitle: asText(slide.subtitle) || null,
    sectionLabel: asText(slide.sectionLabel) || null,
    bullets: normalizeBullets(slide.bullets),
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
    callout: slide.callout
      ? {
          label: asText(slide.callout.label, 'Note'),
          text: asText(slide.callout.text),
        }
      : null,
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
    example: slide.example
      ? {
          problem: asText(slide.example.problem),
          steps: asArray<string>(slide.example.steps)
            .map((step) => asText(step))
            .filter(Boolean),
          solution: asText(slide.example.solution),
        }
      : null,
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
