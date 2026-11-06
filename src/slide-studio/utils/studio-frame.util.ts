import type {
  StudioAnalysis,
  StudioCloComponent,
  StudioContext,
  StudioCover,
  StudioInput,
  StudioPlan,
  StudioSlide,
} from '../slide-studio.types';
import { isStructuralSlide } from './slide-repair.util';
import { stampVisualProvenance, withReferencesSlide } from './studio-references.util';

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
  const linked = input.clos.filter((clo) => clo.linked);
  const clo = linked[0] ?? input.clos[0];
  const hook =
    analysis?.summary?.split(/(?<=[.!?؟])\s+/)[0] ||
    (ar
      ? `لماذا ندرس ${input.topicTitle} في هذا المقرر؟`
      : `Why does ${input.topicTitle} matter in this course?`);
  return {
    ...EMPTY_BODY,
    type: 'INTRODUCTION',
    layout: 'BULLETS',
    title: hook && !/[?؟]/.test(hook) ? hook : input.topicTitle,
    subtitle: null,
    sectionLabel: ar ? 'مقدمة' : 'Introduction',
    bullets: [
    ar
      ? `**السياق** — ${input.topicTitle} كما يظهر في مراجع المقرر.`
      : `**Context** — ${input.topicTitle} as the selected references present it.`,
    ar
      ? '**لماذا يهم** — يبني المهارة التي يطلبها مخرج التعلم المرتبط بهذه المحاضرة.'
      : '**Why it matters** — it builds the skill the linked CLO asks students to demonstrate.',
    clo
      ? ar
        ? `**الربط بمخرج التعلم** — ${clo.code}`
        : `**Link to CLO** — today develops the ${clo.code} component of this outcome.`
      : null,
  ]
    .filter((item): item is string => !!item)
    .slice(0, MAX_FRAME_BULLETS),
    callout: {
      label: ar ? 'فكّر في هذا' : 'Think about it',
      text: hook,
    },
    teachingBeat: 'frame',
    speakerNotes: ar
      ? `مكوّن مخرج التعلم: تأطير المحاضرة. اقرأ سؤال «فكّر في هذا»، اربط الإجابة بمخرج التعلم، ثم انتقل إلى خريطة المحاضرة. لا تدرّس المفهوم الأول هنا.`
      : `CLO component: lecture framing. Read the Think-about-it prompt aloud, collect a student answer, link it to the CLO, then move to the roadmap. Do not teach the first concept here.`,
  };
}

function cloBandLabel(status: StudioCloComponent['status'], ar: boolean) {
  if (status === 'covered') return ar ? 'يُغطى في هذه المحاضرة' : 'Covered in this lecture';
  if (status === 'partial') return ar ? 'تغطية جزئية' : 'Partially covered';
  return ar ? 'غير مغطى هنا' : 'Not covered here';
}

function cloScopeSlide(
  input: StudioInput,
  plan: StudioPlan | null,
  analysis: StudioAnalysis | null,
): StudioSlide {
  const ar = input.language === 'ar';
  const linked = input.clos.filter((clo) => clo.linked);
  const clo = linked[0] ?? input.clos[0];
  const components: StudioCloComponent[] =
    plan?.cloComponents?.length ? plan.cloComponents : analysis?.cloComponents ?? [];
  const band = (status: StudioCloComponent['status']) => {
    const items = components.filter((item) => item.status === status);
    if (!items.length) return null;
    return `**${cloBandLabel(status, ar)}** — ${items.map((item) => item.label).join('; ')}`;
  };
  const bullets = [band('covered'), band('partial'), band('not_covered')].filter(
    Boolean,
  ) as string[];
  const rows = (['covered', 'partial', 'not_covered'] as const)
    .map((status) => {
      const items = components.filter((item) => item.status === status);
      if (!items.length) return null;
      return [cloBandLabel(status, ar), items.map((item) => item.label).join('; ')];
    })
    .filter((row): row is [string, string] => !!row);
  return {
    ...EMPTY_BODY,
    type: 'LEARNING_OUTCOMES',
    layout: 'BULLETS',
    title: ar
      ? `ما الذي تغطيه هذه المحاضرة من ${clo?.code || 'مخرج التعلم'}`
      : `What this lecture covers from ${clo?.code || 'the CLO'}`,
    subtitle: null,
    sectionLabel: ar ? 'مخرج التعلم ونطاق المحاضرة' : 'Course learning outcome & lecture scope',
    bullets: rows.length ? [] : bullets.length ? bullets : plan?.learningGoals.slice(0, MAX_FRAME_BULLETS) ?? [],
    callout: clo
      ? {
          label: `${clo.code}${clo.category ? ` · ${clo.category}` : ''}`,
          text: clo.description,
        }
      : null,
    table: rows.length
      ? {
          headers: [ar ? 'النطاق' : 'In this lecture', ar ? 'المكوّنات' : 'CLO components'],
          rows,
        }
      : null,
    cloCode: clo?.code ?? null,
    teachingBeat: 'frame',
    speakerNotes: ar
      ? `CLO: اقرأ بيان مخرج التعلم كما هو دون إعادة صياغة. وضّح المكوّنات المغطاة والجزئية وغير المغطاة. لا تَدَّعِ أن المحاضرة تحقق مخرج التعلم كاملاً إن بقيت أجزاء لاحقة.`
      : `CLO component: scope-setting. Read the full CLO aloud unchanged. Point out covered vs partial vs not covered. Do not imply students achieve the whole CLO from this lecture alone.`,
  };
}

function roadmapSlide(
  input: StudioInput,
  plan: StudioPlan | null,
  context: StudioContext | null,
): StudioSlide {
  const ar = input.language === 'ar';
  const body = (plan?.sections ?? []).filter((section) => section.phase === 'body');
  const chapter = context?.chapters[0]?.chapterName?.trim() || null;
  const bullets = body.slice(0, MAX_FRAME_BULLETS).map((section, index) => {
    const cue = section.keyPoints[0] ? ` — ${section.keyPoints[0]}` : '';
    return `${index + 1}. **${section.title}**${cue}`;
  });
  return {
    ...EMPTY_BODY,
    type: 'AGENDA',
    layout: 'BULLETS',
    title: chapter
      ? ar
        ? `مسار اليوم عبر ${chapter}`
        : `Today's path through ${chapter}`
      : ar
        ? 'مسار اليوم'
        : "Today's path through the chapter",
    subtitle: null,
    sectionLabel: ar ? 'خريطة المحاضرة' : 'Lecture roadmap',
    bullets,
    teachingBeat: 'frame',
    speakerNotes: ar
      ? 'امشِ على نقاط الخريطة بالترتيب: من التعريف إلى الآلية ثم التطبيق. لا تُدخل مواضيع الفصول الأخرى، ولا تخترع أرقام فقرات غير موجودة في المرجع.'
      : 'Walk the numbered stops in order: what it is, how it works, then how it is used. Skip other-chapter topics. Do not invent section or page numbers the excerpts do not name.',
  };
}

function summarySlide(input: StudioInput, body: StudioSlide[], plan: StudioPlan | null): StudioSlide {
  const ar = input.language === 'ar';
  const content = body.filter(
    (slide) =>
      !isStructuralSlide(slide) &&
      !['CHECKPOINT', 'ACTIVITY', 'INTRODUCTION', 'AGENDA', 'LEARNING_OUTCOMES', 'SUMMARY'].includes(
        typeOf(slide),
      ),
  );
  const step = Math.max(1, content.length / MAX_FRAME_BULLETS);
  const picked: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < content.length && picked.length < MAX_FRAME_BULLETS; i += step) {
    const slide = content[Math.floor(i)];
    const title = String(slide?.title ?? '').trim();
    const claim = String(slide?.bullets?.[0] ?? '').replace(/\*\*(.+?)\*\*/g, '$1').trim();
    if (title && !seen.has(title)) {
      seen.add(title);
      picked.push(claim && claim.length < 90 ? `**${title}** — ${claim}` : `**${title}**`);
    }
  }
  const covered =
    plan?.cloComponents
      ?.filter((item) => item.status === 'covered' || item.status === 'partial')
      .map((item) => item.label)
      .slice(0, 2) ?? [];
  return {
    ...EMPTY_BODY,
    type: 'SUMMARY',
    layout: 'BULLETS',
    title: ar ? 'أبرز النقاط' : 'Key takeaways',
    subtitle: null,
    sectionLabel: ar ? 'خلاصة المحاضرة' : 'Lecture summary',
    bullets: picked.length ? picked.slice(0, MAX_FRAME_BULLETS) : plan?.learningGoals.slice(0, MAX_FRAME_BULLETS) ?? [],
    callout: covered.length
      ? {
          label: ar ? 'مساهمة في مخرج التعلم' : 'Contribution to CLO',
          text: ar
            ? `تطوّر هذه المحاضرة: ${covered.join('؛ ')}`
            : `this lecture develops ${covered.join('; ')}.`,
        }
      : null,
    teachingBeat: 'frame',
    speakerNotes: ar
      ? 'نلخّص ما دُرّس فقط، دون الادعاء بتحقيق مخرج التعلم كاملاً إن بقيت أجزاء لم تُغطَّ. بعد ذلك تحقق من الفهم ثم المراجع.'
      : 'Recap only what was taught; do not claim the full CLO if parts remain for later lectures. Next: check understanding, then references.',
  };
}

function knowledgeCheckSlide(input: StudioInput, plan: StudioPlan | null): StudioSlide {
  const ar = input.language === 'ar';
  const goals = plan?.learningGoals.slice(0, 5) ?? [];
  const bullets =
    goals.length > 0
      ? goals.map((goal, index) => `${index + 1}. ${goal.replace(/\?+$/, '')}?`)
      : [
          ar ? '1. اشرح الفكرة الأساسية لهذه المحاضرة.' : '1. Explain the core idea of this lecture.',
          ar ? '2. أعطِ مثالاً عملياً مما درسناه.' : '2. Give a practical example from today’s content.',
          ar ? '3. قارن مفهومين أساسيين تناولناهما اليوم.' : '3. Compare two key ideas from today’s lecture.',
          ar
            ? '4. ما الذي لم نغطّه من مخرج التعلم بعد؟'
            : '4. Which CLO parts remain for later lectures?',
        ];
  return {
    ...EMPTY_BODY,
    type: 'CHECKPOINT',
    layout: 'BULLETS',
    title: ar ? 'تحقق من الفهم' : 'Check your understanding',
    subtitle: null,
    sectionLabel: ar ? 'تحقق من الفهم' : 'Knowledge check',
    bullets,
    callout: null,
    teachingBeat: 'check',
    speakerNotes: ar
      ? `Answer: ناقش كل سؤال بالترتيب. ${bullets
          .map((_, index) => `${index + 1}) اطلب إجابة قصيرة من القاعة ثم صحّح المصطلح.`)
          .join(' ')} لا تختبر مكوّنات مخرج التعلم غير المغطاة.`
      : `Answer: Work through each numbered question. ${bullets
          .map((_, index) => `${index + 1}) Elicit a short answer, then name the precise term from the chapter.`)
          .join(' ')} Do not assess not-covered CLO parts.`,
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

function withThinkAboutIt(
  slide: StudioSlide,
  fallback: StudioSlide,
): StudioSlide {
  const text = String(slide.callout?.text ?? '').trim();
  return {
    ...slide,
    type: 'INTRODUCTION',
    layout: 'BULLETS',
    title: slide.title || fallback.title,
    subtitle: slide.subtitle || fallback.subtitle,
    sectionLabel: slide.sectionLabel || fallback.sectionLabel,
    bullets: slide.bullets?.length ? slide.bullets : fallback.bullets,
    callout: text
      ? { label: slide.callout?.label || fallback.callout?.label || 'Think about it', text }
      : fallback.callout,
    speakerNotes: slide.speakerNotes || fallback.speakerNotes,
  };
}

function withCloBands(slide: StudioSlide, fallback: StudioSlide): StudioSlide {
  const hasTable = Boolean(slide.table?.headers?.length && slide.table.rows?.length);
  const hasCallout = Boolean(String(slide.callout?.text ?? '').trim());
  return {
    ...slide,
    type: 'LEARNING_OUTCOMES',
    layout: 'BULLETS',
    title: slide.title || fallback.title,
    subtitle: slide.subtitle || fallback.subtitle,
    callout: hasCallout ? slide.callout : fallback.callout,
    table: hasTable ? slide.table : fallback.table,
    bullets: hasTable || slide.bullets?.length ? slide.bullets ?? [] : fallback.bullets,
    cloCode: slide.cloCode || fallback.cloCode,
    speakerNotes: slide.speakerNotes || fallback.speakerNotes,
  };
}

function withPartialBanners(slides: StudioSlide[], plan: StudioPlan | null, ar: boolean): StudioSlide[] {
  const partial = new Set(
    (plan?.cloComponents ?? [])
      .filter((item) => item.status === 'partial')
      .map((item) => item.cloCode.trim().toUpperCase())
      .filter(Boolean),
  );
  if (!partial.size) return slides;
  const banner = ar ? 'تغطية جزئية — يُستكمل لاحقاً' : 'Partially covered — continued later';
  return slides.map((slide) => {
    const code = String(slide.cloCode ?? '').trim().toUpperCase();
    if (!code || !partial.has(code) || String(slide.sectionLabel ?? '').trim()) return slide;
    if (['TITLE', 'LEARNING_OUTCOMES', 'AGENDA', 'INTRODUCTION', 'SUMMARY', 'CHECKPOINT', 'REFERENCES'].includes(typeOf(slide))) {
      return slide;
    }
    return { ...slide, sectionLabel: banner };
  });
}

/**
 * Safety-net lecture frame (PO arc). Prefer outline/writer to emit these;
 * here we only insert missing TITLE / LEARNING_OUTCOMES / AGENDA / INTRODUCTION /
 * SUMMARY / CHECKPOINT, then REFERENCES.
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
  let body = (isTitleSlide(first) ? slides.slice(1) : slides).filter(
    (slide) => typeOf(slide) !== 'REFERENCES',
  );
  const cover = coverSlide(input, isTitleSlide(first) ? first : undefined);

  const take = (type: string) => {
    const at = body.findIndex((slide) => typeOf(slide) === type);
    if (at < 0) return null;
    const slide = body[at];
    body = body.filter((_, i) => i !== at);
    return slide;
  };

  const cloFallback = cloScopeSlide(input, plan, analysis);
  const introFallback = introductionSlide(input, plan, analysis);
  const cloTaken = take('LEARNING_OUTCOMES');
  const introTaken = take('INTRODUCTION');
  const cloScope = cloTaken ? withCloBands(cloTaken, cloFallback) : cloFallback;
  const roadmap = take('AGENDA') ?? roadmapSlide(input, plan, context);
  const introduction = introTaken ? withThinkAboutIt(introTaken, introFallback) : introFallback;

  let summary =
    take('SUMMARY') ??
    (() => {
      const conclusionAt = lastIndex(body, (slide) => typeOf(slide) === 'CONCLUSION');
      if (conclusionAt >= 0) {
        const slide = {
          ...body[conclusionAt],
          type: 'SUMMARY',
          layout: 'BULLETS',
          sectionLabel: ar ? 'الخلاصة' : 'Summary',
        };
        body = body.filter((_, i) => i !== conclusionAt);
        return slide;
      }
      return summarySlide(input, body, plan);
    })();

  // Closing knowledge check: prefer the last CHECKPOINT; leave earlier ACTIVITY/CHECKPOINT in body.
  const checkAt = lastIndex(body, (slide) => typeOf(slide) === 'CHECKPOINT');
  let knowledgeCheck =
    checkAt >= 0
      ? {
          ...body[checkAt],
          type: 'CHECKPOINT',
          layout: 'BULLETS',
          title: body[checkAt].title || (ar ? 'تحقق من الفهم' : 'Check your understanding'),
          subtitle: null,
          sectionLabel: body[checkAt].sectionLabel || (ar ? 'تحقق من الفهم' : 'Knowledge check'),
        }
      : knowledgeCheckSlide(input, plan);
  if (checkAt >= 0) body = body.filter((_, i) => i !== checkAt);
  if (!knowledgeCheck.bullets?.length && !knowledgeCheck.callout?.text) {
    knowledgeCheck = knowledgeCheckSlide(input, plan);
  }

  // Normalize summary labels to Clause-style wording.
  summary = {
    ...summary,
    type: 'SUMMARY',
    layout: 'BULLETS',
    title: summary.title || (ar ? 'أبرز النقاط' : 'Key takeaways'),
    subtitle: null,
    sectionLabel: summary.sectionLabel || (ar ? 'خلاصة المحاضرة' : 'Lecture summary'),
  };
  if (!summary.bullets?.length && !summary.callout?.text) {
    summary = summarySlide(input, body, plan);
  }

  // Drop a legacy CONCLUSION if SUMMARY already closes the teaching arc.
  body = body.filter((slide) => typeOf(slide) !== 'CONCLUSION');
  body = withPartialBanners(body, plan, ar);

  const framed = [
    cover,
    cloScope,
    roadmap,
    introduction,
    ...body,
    summary,
    knowledgeCheck,
  ].map((slide, index) =>
    stampVisualProvenance(
      {
        ...slide,
        slideNumber: index + 1,
      },
      input.language,
    ),
  );
  return withReferencesSlide(framed, context, input.language);
}
