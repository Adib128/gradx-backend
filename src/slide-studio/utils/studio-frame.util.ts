import type {
  StudioAnalysis,
  StudioContext,
  StudioCover,
  StudioInput,
  StudioPlan,
  StudioSlide,
} from '../slide-studio.types';
import { isStructuralSlide } from './slide-repair.util';
import { withReferencesSlide } from './studio-references.util';

const MAX_FRAME_BULLETS = 5;

const typeOf = (slide: StudioSlide | undefined) => String(slide?.type ?? '').toUpperCase();
const layoutOf = (slide: StudioSlide | undefined) => String(slide?.layout ?? '').toUpperCase();

const isTitleSlide = (slide: StudioSlide | undefined) =>
  typeOf(slide) === 'TITLE' || layoutOf(slide) === 'TITLE_CENTER';

const EMPTY_BODY = {
  sectionLabel: null,
  leftColumn: null,
  rightColumn: null,
  callout: null,
  example: null,
  formula: null,
  table: null,
  diagram: null,
  code: null,
  image: null,
  cloCode: null,
  bloomLevel: null,
};

const SEMESTERS: Record<string, { en: string; ar: string }> = {
  FIRST: { en: 'First semester', ar: 'الفصل الدراسي الأول' },
  SECOND: { en: 'Second semester', ar: 'الفصل الدراسي الثاني' },
  THIRD: { en: 'Third semester', ar: 'الفصل الدراسي الثالث' },
  SUMMER: { en: 'Summer semester', ar: 'الفصل الصيفي' },
};

/** "FIRST" → "First semester"; free text is kept as typed. */
export function semesterLabel(value: string | null | undefined, language: StudioInput['language']): string | null {
  const text = value?.trim();
  if (!text) return null;
  const known = SEMESTERS[text.toUpperCase()];
  return known ? known[language] : text;
}

function coverOf(input: StudioInput): StudioCover {
  return (
    input.cover ?? {
      universityName: null,
      universityLogo: null,
      college: null,
      courseTitle: input.courseTitle,
      courseCode: input.courseCode,
      topicNumber: input.topicNumber,
      topicTitle: input.topicTitle,
      academicYear: null,
      semester: null,
      instructorName: null,
    }
  );
}

/** Cover built from course data (never paginated); keeps the writer's speaker notes. */
export function coverSlide(input: StudioInput, written?: StudioSlide): StudioSlide {
  const ar = input.language === 'ar';
  return {
    ...EMPTY_BODY,
    type: 'TITLE',
    layout: 'TITLE_CENTER',
    title: input.topicTitle,
    subtitle: null,
    bullets: [],
    cover: coverOf(input),
    speakerNotes:
      written?.speakerNotes ||
      (ar
        ? `مرحبًا بكم في محاضرة اليوم: ${input.topicTitle}. سنبدأ بمقدمة توضح أهمية الموضوع وما سنتناوله.`
        : `Welcome to today's lecture: ${input.topicTitle}. We start with a short introduction to why this topic matters and what we will cover.`),
  };
}

/** Slide 1 becomes the cover (same slide count, safe while the deck is still streaming). */
export function withCoverSlide(slides: StudioSlide[], input: StudioInput): StudioSlide[] {
  if (!slides.length) return slides;
  if (isTitleSlide(slides[0])) return [coverSlide(input, slides[0]), ...slides.slice(1)];
  return [coverSlide(input), ...slides];
}

function introductionSlide(input: StudioInput, plan: StudioPlan | null, analysis: StudioAnalysis | null): StudioSlide {
  const ar = input.language === 'ar';
  const sections = plan?.sections ?? [];
  const core = sections.length > 3 ? sections.slice(1, -1) : sections;
  const bullets = core.map((section) => section.title).filter(Boolean).slice(0, MAX_FRAME_BULLETS);
  return {
    ...EMPTY_BODY,
    type: 'INTRODUCTION',
    layout: 'BULLETS',
    title: ar ? 'مقدمة' : 'Introduction',
    subtitle: analysis?.summary?.split(/(?<=[.!?؟])\s+/)[0] ?? null,
    sectionLabel: ar ? 'مقدمة' : 'Introduction',
    bullets: bullets.length ? bullets : plan?.learningGoals.slice(0, MAX_FRAME_BULLETS) ?? [],
    speakerNotes: ar
      ? `قبل أن نبدأ، لنتعرّف على ما سنتناوله في هذه المحاضرة عن ${input.topicTitle} ولماذا هو مهم.`
      : `Before we start, here is what this lecture on ${input.topicTitle} covers and why it matters.`,
  };
}

/** Key takeaways from the deck's own assertion headlines. */
function conclusionSlide(input: StudioInput, body: StudioSlide[], plan: StudioPlan | null): StudioSlide {
  const ar = input.language === 'ar';
  const content = body.filter(
    (slide) =>
      !isStructuralSlide(slide) &&
      !['CHECKPOINT', 'ACTIVITY', 'INTRODUCTION', 'AGENDA', 'LEARNING_OUTCOMES'].includes(typeOf(slide)),
  );
  const step = Math.max(1, content.length / MAX_FRAME_BULLETS);
  const picked: string[] = [];
  for (let i = 0; i < content.length && picked.length < MAX_FRAME_BULLETS; i += step) {
    const title = String(content[Math.floor(i)]?.title ?? '').trim();
    if (title && !picked.includes(title)) picked.push(title);
  }
  return {
    ...EMPTY_BODY,
    type: 'CONCLUSION',
    layout: 'BULLETS',
    title: ar ? 'الخلاصة' : 'Conclusion',
    subtitle: null,
    sectionLabel: ar ? 'الخلاصة' : 'Conclusion',
    bullets: picked.length ? picked : plan?.learningGoals.slice(0, MAX_FRAME_BULLETS) ?? [],
    speakerNotes: ar
      ? 'لنلخّص أهم الأفكار التي تناولناها اليوم قبل الانتقال إلى المراجع.'
      : "Let's wrap up the key ideas from today before we look at the references.",
  };
}

const lastIndex = (slides: StudioSlide[], match: (slide: StudioSlide) => boolean) => {
  for (let i = slides.length - 1; i >= 0; i -= 1) if (match(slides[i])) return i;
  return -1;
};

/**
 * Final lecture structure: cover → introduction → teaching slides → conclusion → references.
 * Missing introduction/conclusion slides are added; the last summary becomes the conclusion.
 */
export function withLectureFrame(
  slides: StudioSlide[],
  input: StudioInput,
  plan: StudioPlan | null,
  analysis: StudioAnalysis | null,
  context: StudioContext | null,
): StudioSlide[] {
  const ar = input.language === 'ar';
  const first = slides[0];
  let body = (isTitleSlide(first) ? slides.slice(1) : slides).filter((slide) => typeOf(slide) !== 'REFERENCES');
  const cover = coverSlide(input, isTitleSlide(first) ? first : undefined);

  const introAt = body.findIndex((slide) => typeOf(slide) === 'INTRODUCTION');
  const introduction = introAt >= 0 ? body[introAt] : introductionSlide(input, plan, analysis);
  if (introAt >= 0) body = body.filter((_, i) => i !== introAt);

  let conclusionAt = lastIndex(body, (slide) => typeOf(slide) === 'CONCLUSION');
  if (conclusionAt < 0) conclusionAt = lastIndex(body, (slide) => typeOf(slide) === 'SUMMARY');
  const conclusion =
    conclusionAt >= 0
      ? {
          ...body[conclusionAt],
          type: 'CONCLUSION',
          layout: 'BULLETS',
          sectionLabel: ar ? 'الخلاصة' : 'Conclusion',
        }
      : conclusionSlide(input, body, plan);
  if (conclusionAt >= 0) body = body.filter((_, i) => i !== conclusionAt);

  const framed = [cover, introduction, ...body, conclusion].map((slide, index) => ({
    ...slide,
    slideNumber: index + 1,
  }));
  return withReferencesSlide(framed, context, input.language);
}
