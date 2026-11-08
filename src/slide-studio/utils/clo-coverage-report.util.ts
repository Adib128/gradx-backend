import type {
  CloCoverageStatus,
  StudioCloComponent,
  StudioOutlineItem,
  StudioPlan,
  StudioReview,
  StudioSlide,
} from '../slide-studio.types';

export type CloCoverageSlideLink = {
  /** 1-based slide number. */
  number: number;
  title: string;
  type: string;
  cloCode: string | null;
};

export type CloCoverageComponentRow = {
  id: string;
  cloCode: string;
  label: string;
  status: CloCoverageStatus;
  slides: CloCoverageSlideLink[];
  note: string;
  /** Deterministic gap flag for instructor review. */
  gap:
    | 'none'
    | 'covered_without_slides'
    | 'partial_thin'
    | 'unmapped_slide'
    | 'summary_overclaim';
};

export type CloCoverageReport = {
  components: CloCoverageComponentRow[];
  byCode: Array<{ code: string; slides: CloCoverageSlideLink[] }>;
  unmappedSlides: CloCoverageSlideLink[];
  gaps: Array<{ severity: 'high' | 'medium' | 'low'; message: string; slide?: number }>;
  summary: string;
  /** From the AI reviewer when present. */
  reviewScore: number | null;
};

const FRAME_TYPES = new Set([
  'TITLE',
  'LEARNING_OUTCOMES',
  'AGENDA',
  'INTRODUCTION',
  'SUMMARY',
  'CHECKPOINT',
  'REFERENCES',
  'CONCLUSION',
]);

function slideLink(slide: StudioSlide, index: number): CloCoverageSlideLink {
  return {
    number: index + 1,
    title: String(slide.title || `Slide ${index + 1}`),
    type: String(slide.type || 'CONTENT').toUpperCase(),
    cloCode: slide.cloCode ? String(slide.cloCode) : null,
  };
}

function normalizeCode(value: string | null | undefined) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/^CLO\s*/i, 'CLO ')
    .replace(/\s+/g, ' ');
}

function codesMatch(a: string | null | undefined, b: string | null | undefined) {
  const left = normalizeCode(a);
  const right = normalizeCode(b);
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}

/**
 * Builds an instructor-facing CLO ↔ slide coverage report from plan components
 * and the current deck. Uses reviewer notes when available, but the slide links
 * and gaps are computed deterministically.
 */
export function buildCloCoverageReport(options: {
  slides: StudioSlide[];
  plan?: StudioPlan | null;
  outline?: StudioOutlineItem[] | null;
  review?: StudioReview | null;
}): CloCoverageReport {
  const slides = options.slides ?? [];
  const components: StudioCloComponent[] =
    options.plan?.cloComponents?.length
      ? options.plan.cloComponents
      : (options.review?.cloComponentCoverage ?? []).map((item) => ({
          id: item.id,
          cloCode: item.cloCode,
          label: item.label,
          status: item.status,
          evidence: item.note || '',
        }));

  const reviewNotes = new Map(
    (options.review?.cloComponentCoverage ?? []).map((item) => [item.id, item]),
  );

  const contentSlides = slides
    .map((slide, index) => ({ slide, index, link: slideLink(slide, index) }))
    .filter(({ link }) => !FRAME_TYPES.has(link.type) || link.type === 'INTRODUCTION');

  const rows: CloCoverageComponentRow[] = components.map((component) => {
    const linked = contentSlides
      .filter(({ slide, index }) => {
        const outlineCode = options.outline?.[index]?.cloCode;
        return (
          codesMatch(slide.cloCode, component.cloCode) ||
          codesMatch(outlineCode, component.cloCode)
        );
      })
      .map(({ link }) => link);

    const review = reviewNotes.get(component.id);
    let gap: CloCoverageComponentRow['gap'] = 'none';
    if (component.status === 'covered' && linked.length === 0) {
      gap = 'covered_without_slides';
    } else if (component.status === 'partial' && linked.length <= 1) {
      gap = 'partial_thin';
    }

    return {
      id: component.id,
      cloCode: component.cloCode,
      label: component.label,
      status: component.status,
      slides: linked,
      note: review?.note || component.evidence || '',
      gap,
    };
  });

  const knownCodes = rows.map((row) => row.cloCode).filter(Boolean);
  const unmappedSlides = contentSlides
    .filter(({ link }) => {
      if (!link.cloCode) return true;
      return !knownCodes.some((code) => codesMatch(code, link.cloCode));
    })
    .map(({ link }) => link);

  const byCodeMap = new Map<string, CloCoverageSlideLink[]>();
  for (const { link } of contentSlides) {
    const code = link.cloCode || 'UNMAPPED';
    const list = byCodeMap.get(code) ?? [];
    list.push(link);
    byCodeMap.set(code, list);
  }

  const gaps: CloCoverageReport['gaps'] = [];
  for (const row of rows) {
    if (row.gap === 'covered_without_slides') {
      gaps.push({
        severity: 'high',
        message: `${row.cloCode || row.label} is marked covered but no teaching slide is linked.`,
      });
    } else if (row.gap === 'partial_thin') {
      gaps.push({
        severity: 'medium',
        message: `${row.cloCode || row.label} is only partially covered (${row.slides.length} slide${row.slides.length === 1 ? '' : 's'}).`,
      });
    }
  }
  for (const slide of unmappedSlides) {
    gaps.push({
      severity: 'medium',
      slide: slide.number,
      message: `Slide ${slide.number} (“${slide.title}”) has no matching CLO component.`,
    });
  }

  const summarySlide = slides.findIndex(
    (slide) => String(slide.type || '').toUpperCase() === 'SUMMARY',
  );
  if (summarySlide >= 0) {
    const overclaim = rows.some((row) => row.status === 'not_covered');
    if (overclaim) {
      gaps.push({
        severity: 'low',
        slide: summarySlide + 1,
        message:
          'Some CLO components are not_covered — the summary must not claim the whole CLO.',
      });
    }
  }

  const covered = rows.filter((row) => row.status === 'covered').length;
  const partial = rows.filter((row) => row.status === 'partial').length;
  const missing = rows.filter((row) => row.gap !== 'none').length;
  const summary =
    rows.length === 0
      ? 'No CLO components were recorded for this lecture.'
      : `${covered} covered, ${partial} partial, ${rows.length - covered - partial} not covered · ${missing} gap${missing === 1 ? '' : 's'} to review.`;

  return {
    components: rows,
    byCode: [...byCodeMap.entries()].map(([code, linked]) => ({
      code,
      slides: linked,
    })),
    unmappedSlides,
    gaps,
    summary,
    reviewScore: options.review?.score ?? null,
  };
}
