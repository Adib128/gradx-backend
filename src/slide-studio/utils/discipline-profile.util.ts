import type {
  StudioAnalysis,
  StudioExcerpt,
  StudioInput,
  StudioOutlineItem,
  StudioQaFinding,
  StudioSlide,
} from '../slide-studio.types';

export const DISCIPLINE_IDS = [
  'mathematics',
  'programming',
  'computing',
  'natural_science',
  'engineering',
  'health',
  'business',
  'social_science',
  'humanities',
  'law',
  'language',
  'general',
] as const;
export type DisciplineId = (typeof DISCIPLINE_IDS)[number];

/** Slide types that carry the body of a lecture (not title/agenda/checkpoint/summary). */
export const CORE_TYPES = new Set([
  'CONTENT',
  'DEFINITION',
  'FORMULA',
  'EXAMPLE',
  'COMPARISON',
  'DIAGRAM',
  'CODE',
]);

const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const has = {
  formula: (slide: StudioSlide) => Boolean(str(slide.formula?.latex)),
  code: (slide: StudioSlide) => Boolean(str(slide.code?.source)),
  example: (slide: StudioSlide) =>
    Boolean(slide.example && ((slide.example.steps?.length ?? 0) > 0 || str(slide.example.problem))),
  table: (slide: StudioSlide) => Boolean(slide.table?.headers?.length && slide.table.rows?.length),
  figure: (slide: StudioSlide) => Boolean(str((slide as { image?: { src?: string } }).image?.src)),
  diagram: (slide: StudioSlide) => Boolean(str(slide.diagram?.mermaid)),
  callout: (slide: StudioSlide) => Boolean(str(slide.callout?.text)),
  columns: (slide: StudioSlide) =>
    Boolean(slide.leftColumn?.bullets?.length && slide.rightColumn?.bullets?.length),
};

type Retype = { type: string; layout: string; match: RegExp; visual?: 'mermaid' };

export type DisciplineProfile = {
  id: DisciplineId;
  label: string;
  /** The field's signature evidence, named for prompts and findings. */
  evidence: string;
  /** Share of core slides that must carry the signature evidence. */
  minShare: number;
  /** Does a written slide carry the signature evidence? */
  carries(slide: StudioSlide): boolean;
  /** Will an outline item carry it once written? */
  plans(item: Pick<StudioOutlineItem, 'type' | 'visual'>): boolean;
  /** How a plain CONTENT outline item whose title/intent matches becomes a signature slide. */
  retype?: Retype;
  /** Discipline teaching rules for the planner, outliner, writer and optimizer. */
  rules: string[];
  /** What the inspector and reviewer must verify for this field. */
  audit: string;
};

const visualPlanned = (item: Pick<StudioOutlineItem, 'visual'>) => item.visual.kind !== 'none';
const typed =
  (...types: string[]) =>
  (item: Pick<StudioOutlineItem, 'type' | 'visual'>) =>
    types.includes(item.type.toUpperCase());

export const DISCIPLINES: Record<DisciplineId, DisciplineProfile> = {
  mathematics: {
    id: 'mathematics',
    label: 'Mathematics & statistics',
    evidence: 'formulas and step-by-step worked examples',
    minShare: 0.45,
    carries: (slide) => has.formula(slide) || has.example(slide) || has.table(slide),
    plans: typed('FORMULA', 'EXAMPLE'),
    retype: {
      type: 'FORMULA',
      layout: 'FORMULA_FOCUS',
      match:
        /(formula|equation|theorem|identity|\brule\b|law of|derivative|integral|limit|series|probability|expected value|variance|distribution|matrix|determinant|eigen|proof|derive|calculat|comput|معادلة|قانون|نظرية|مشتقة|تكامل|احتمال|مصفوفة|برهان|حساب)/i,
    },
    rules: [
      'Every key result is a FORMULA slide: formula.latex in valid KaTeX and an explanation that names every symbol (with its unit when it has one) and the conditions under which the result holds.',
      'Each new formula or method is followed by an EXAMPLE slide with concrete numbers: one algebraic step per line, each step naming the rule it uses ("Chain rule: …"), and a solution that interprets the result.',
      'Fade the guidance: a second example of the same method leaves its last step to the students as a CHECKPOINT, with the answer in speakerNotes.',
      'Show one typical error (e.g. a forgotten condition or sign) and why it fails, and keep proofs to their key idea and steps.',
      'In bullets write math with Unicode (x², √n, ≤, π, Σ); only formula.latex is typeset, so never put raw LaTeX in bullets. Use a table for value lists (x | f(x)).',
    ],
    audit:
      'Recompute every formula application and example step, check that each symbol is defined and that theorem conditions are stated.',
  },
  programming: {
    id: 'programming',
    label: 'Programming & software development',
    evidence: 'short runnable code examples with their output',
    minShare: 0.4,
    carries: (slide) => has.code(slide),
    plans: typed('CODE'),
    retype: {
      type: 'CODE',
      layout: 'BULLETS',
      match:
        /(syntax|code|implement|function|method|class|object|loop|recursion|array|list|string|variable|statement|condition|query|select|join|command|program|script|api|exception|pointer|operator|algorithm|example|كود|برمج|دالة|حلقة|مصفوفة|متغير|استعلام|أمر|خوارزمية)/i,
    },
    rules: [
      'CODE slides carry code {language, source ≤ 12 lines and ≤ 60 characters per line, highlight: the 1-3 line numbers that matter, output: the exact output when run (≤ 3 lines)} plus 1-3 short bullets explaining the highlighted lines.',
      "Show real, runnable code in the course's language as used in the excerpts (Python, Java, C++, SQL, shell…), with meaningful names and no placeholders inside the logic.",
      'One concept per snippet, built up across slides: minimal example → variation → a common bug and its fix.',
      'Trace algorithms with a table (step | variables | output) instead of prose; show structure (classes, call flow) as a classDiagram or flowchart rather than a long listing.',
      'Refer to identifiers in bullets in **bold**; never put more than 12 lines of code on one slide.',
    ],
    audit:
      'Execute every snippet mentally: it must compile/run, the stated output must be exactly what it prints, and the highlighted lines must be the ones the bullets discuss.',
  },
  computing: {
    id: 'computing',
    label: 'Computing systems & theory',
    evidence: 'architecture/process diagrams, commands or code, and comparison tables',
    minShare: 0.5,
    carries: (slide) => has.diagram(slide) || has.figure(slide) || has.code(slide) || has.table(slide),
    plans: (item) => visualPlanned(item) || typed('CODE', 'COMPARISON')(item),
    retype: {
      type: 'CODE',
      layout: 'BULLETS',
      match: /(command|shell|terminal|system call|syscall|query|sql|configur|script|كود|أمر|استعلام)/i,
    },
    rules: [
      'Architectures and layers as flowchart TD, message exchanges and protocols as sequenceDiagram, process/thread/connection life cycles as stateDiagram-v2.',
      'Commands, system calls, queries and configuration appear as CODE slides (language shell, c, sql…; ≤ 10 lines) with the exact output.',
      'Compare mechanisms or policies (scheduling, routing, storage…) in a table with concrete numbers, and trace one concrete run step by step.',
    ],
    audit:
      'Check commands, outputs and protocol/algorithm steps for correctness and order, and numbers in traces and tables.',
  },
  natural_science: {
    id: 'natural_science',
    label: 'Natural sciences',
    evidence: 'reference figures, labelled mechanism diagrams and data',
    minShare: 0.55,
    carries: (slide) => has.figure(slide) || has.diagram(slide) || has.table(slide) || has.formula(slide),
    plans: (item) => visualPlanned(item) || typed('FORMULA', 'COMPARISON')(item),
    retype: {
      type: 'DIAGRAM',
      layout: 'BULLETS',
      visual: 'mermaid',
      match:
        /(process|cycle|mechanism|pathway|structure|reaction|transport|stage|phase|flow|cascade|transfer|عملية|دورة|آلية|مراحل|تفاعل|بنية)/i,
    },
    rules: [
      'Assertion–evidence: the headline states a finding and the body is the evidence — a reference figure first, otherwise a labelled diagram of the mechanism or process.',
      'Quantities carry SI units and sensible significant figures; chemical and physical equations are FORMULA slides in KaTeX (\\text{H}_2\\text{O}, \\rightarrow).',
      'Present experiments as question → method → result → conclusion, with data in a table whose headers carry the units.',
      'Distinguish observation, model and theory, and name the evidence (experiment, study) behind each claim.',
    ],
    audit:
      'Check units and significant figures, that equations are balanced, and that each figure or diagram actually shows the claim in the headline.',
  },
  engineering: {
    id: 'engineering',
    label: 'Engineering',
    evidence: 'governing equations, system diagrams and design calculations',
    minShare: 0.55,
    carries: (slide) =>
      has.formula(slide) || has.diagram(slide) || has.figure(slide) || has.example(slide) || has.table(slide),
    plans: (item) => visualPlanned(item) || typed('FORMULA', 'EXAMPLE', 'COMPARISON')(item),
    retype: {
      type: 'EXAMPLE',
      layout: 'EXAMPLE_STEPS',
      match:
        /(design|sizing|calculat|stress|strain|load|power|current|voltage|efficiency|flow rate|heat transfer|torque|تصميم|حساب|إجهاد|حمل|قدرة|جهد|كفاءة)/i,
    },
    rules: [
      'Systems as block diagrams (flowchart LR: input → components → output); governing equations as FORMULA slides with the unit of every symbol.',
      'Design calculations as EXAMPLE slides: given values with units and assumptions → steps → result with units → check against a limit, standard or safety factor.',
      'Compare materials, components or design options in a table of specifications; name the standard or code when the reference does.',
    ],
    audit: 'Check unit consistency, arithmetic, stated assumptions and limits in every calculation.',
  },
  health: {
    id: 'health',
    label: 'Medicine & health sciences',
    evidence: 'clinical cases, pathophysiology diagrams and comparison tables',
    minShare: 0.5,
    carries: (slide) =>
      has.table(slide) || has.figure(slide) || has.diagram(slide) || has.example(slide) || has.columns(slide),
    plans: (item) => visualPlanned(item) || typed('EXAMPLE', 'COMPARISON')(item),
    retype: {
      type: 'EXAMPLE',
      layout: 'EXAMPLE_STEPS',
      match: /(case|patient|presentation|diagnos|management|treatment|assessment|حالة|مريض|تشخيص|علاج|تقييم)/i,
    },
    rules: [
      'Teach through a de-identified clinical vignette as an EXAMPLE: problem = age, sex, presenting complaint and key findings; steps = history/examination → investigations → differential → management; solution = diagnosis and the learning point.',
      'Pathophysiology as a cause → mechanism → clinical feature chain (flowchart LR).',
      'Differentials, drug classes and investigations as tables (≤ 4 columns); red flags and patient-safety points in a callout.',
      'Give drug doses, thresholds and guideline recommendations only exactly as the references state them (with the guideline and year); otherwise leave them out.',
    ],
    audit:
      'Check clinical facts, doses and thresholds against the excerpts (never invented), and that vignettes are de-identified and clinically coherent.',
  },
  business: {
    id: 'business',
    label: 'Business, economics & management',
    evidence: 'worked numeric cases, metric formulas and comparison tables',
    minShare: 0.45,
    carries: (slide) => has.table(slide) || has.example(slide) || has.formula(slide) || has.diagram(slide),
    plans: (item) => visualPlanned(item) || typed('EXAMPLE', 'FORMULA', 'COMPARISON')(item),
    retype: {
      type: 'EXAMPLE',
      layout: 'EXAMPLE_STEPS',
      match:
        /(calculat|ratio|cost|price|revenue|profit|margin|npv|break.?even|elastic|budget|valuation|forecast|case|حساب|تكلفة|سعر|إيراد|ربح|نسبة|ميزانية|حالة)/i,
    },
    rules: [
      'Apply every concept to a concrete case (a company or market, Saudi context where natural) with real-looking numbers in SAR.',
      'Calculations as EXAMPLE slides: data → formula → steps → result → the managerial decision it supports; key metrics and ratios as FORMULA slides.',
      'Fill frameworks (SWOT, Porter, 4P, value chain) with the case in a table instead of listing their generic boxes; compare options against criteria in a table.',
    ],
    audit: 'Check arithmetic, currency and units, and that each interpretation follows from the numbers.',
  },
  social_science: {
    id: 'social_science',
    label: 'Social sciences & education',
    evidence: 'theory models, research evidence and applied scenarios',
    minShare: 0.4,
    carries: (slide) =>
      has.diagram(slide) || has.table(slide) || has.callout(slide) || has.figure(slide) || has.example(slide),
    plans: (item) => visualPlanned(item) || typed('COMPARISON', 'EXAMPLE')(item),
    rules: [
      'Show each theory as a model: a diagram of its constructs and their relations; compare theories in a table (theorist | key idea | evidence | critique).',
      'Back claims with research as the excerpts report it: study, sample, finding.',
      "Apply ideas to a realistic scenario from the students' context as an EXAMPLE or ACTIVITY.",
    ],
    audit: 'Check that theories are attributed correctly and research findings are represented faithfully.',
  },
  humanities: {
    id: 'humanities',
    label: 'Humanities',
    evidence: 'primary-source quotations, timelines and contrasting interpretations',
    minShare: 0.4,
    carries: (slide) =>
      has.callout(slide) || has.diagram(slide) || has.figure(slide) || has.table(slide) || has.columns(slide),
    plans: (item) => visualPlanned(item) || typed('COMPARISON', 'DEFINITION')(item),
    rules: [
      'Quote short primary-source passages (≤ 35 words) exactly in a QUOTE_CALLOUT whose label names the author and work, followed by 1-2 bullets interpreting them.',
      'Chronologies as a mermaid timeline (or flowchart LR of dated events); arguments as claim → reasons → evidence diagrams.',
      'Contrast schools or interpretations in TWO_COLUMN and end sections with an open discussion question.',
    ],
    audit: 'Check quotations, attributions, dates and names against the excerpts.',
  },
  law: {
    id: 'law',
    label: 'Law & Sharia',
    evidence: 'quoted provisions, case analyses (IRAC) and comparison tables',
    minShare: 0.5,
    carries: (slide) =>
      has.callout(slide) || has.table(slide) || has.columns(slide) || has.example(slide) || has.diagram(slide),
    plans: (item) => visualPlanned(item) || typed('DEFINITION', 'EXAMPLE', 'COMPARISON')(item),
    retype: {
      type: 'EXAMPLE',
      layout: 'EXAMPLE_STEPS',
      match: /(case|scenario|dispute|apply|application|ruling|قضية|حالة|نزاع|تطبيق|حكم)/i,
    },
    rules: [
      'Quote the governing article or provision exactly, with its number and the law it belongs to, in a DEFINITION or QUOTE_CALLOUT.',
      'Apply rules to a case as an EXAMPLE using IRAC: problem = facts; steps = issue → rule → application; solution = conclusion.',
      'Procedures as flowchart LR; elements of an offence or contract and comparisons of legal regimes as tables.',
      'Never invent article numbers, cases, rulings or penalties.',
    ],
    audit: 'Check every cited provision, number and ruling against the excerpts and that each application follows its rule.',
  },
  language: {
    id: 'language',
    label: 'Language & linguistics',
    evidence: 'pattern tables, model sentences and practice',
    minShare: 0.45,
    carries: (slide) => has.table(slide) || has.example(slide) || has.callout(slide) || has.columns(slide),
    plans: (item) => typed('EXAMPLE', 'COMPARISON', 'DEFINITION', 'CHECKPOINT')(item) || visualPlanned(item),
    rules: [
      'Pattern → examples → practice: present forms in a table (form | meaning/use | example).',
      'Give natural model sentences, with a gloss or translation when it helps; contrast confusable forms in TWO_COLUMN.',
      'Show common learner errors with their correction and add short practice CHECKPOINTs often.',
    ],
    audit: 'Check that every example sentence is correct and natural and that rules are stated precisely.',
  },
  general: {
    id: 'general',
    label: 'General',
    evidence: 'visuals, worked examples and structured comparisons',
    minShare: 0.45,
    carries: (slide) =>
      has.figure(slide) ||
      has.diagram(slide) ||
      has.table(slide) ||
      has.example(slide) ||
      has.formula(slide) ||
      has.code(slide) ||
      has.columns(slide),
    plans: (item) => visualPlanned(item) || typed('EXAMPLE', 'FORMULA', 'COMPARISON', 'CODE')(item),
    rules: [
      'Pick the evidence that teaches each idea best: a reference figure, a diagram of a process, a worked example, a comparison table or a formula.',
    ],
    audit: 'Check facts, numbers and examples against the excerpts.',
  },
};

/** Keyword evidence per discipline (English and Arabic course vocabulary). */
const KEYWORDS: Array<[DisciplineId, RegExp]> = [
  [
    'mathematics',
    /\b(math|mathematics|calculus|algebra|statistic|probability|geometry|trigonometry|discrete math|linear algebra|differential equation|numerical (methods|analysis)|real analysis|biostatistic|operations? research|operational research|optimi[sz]ation|linear programming|game theory|queu(e|ing) theory)|بحوث العمليات|رياضيات|تفاضل|تكامل|جبر|إحصاء|احتمالات|حسبان/i,
  ],
  [
    'programming',
    /\b((?<!(linear|integer|goal|mathematical|nonlinear|non-linear) )programming|software (engineering|development)|coding|python|java\b|c\+\+|javascript|typescript|data structures?|object[- ]oriented|web development|mobile development|algorithms?)|برمجة|هياكل البيانات|خوارزميات|تطوير البرمجيات/i,
  ],
  [
    'computing',
    /\b(computer science|computing|operating systems?|computer networks?|networking|databases?|information systems?|cyber ?security|computer architecture|artificial intelligence|machine learning|cloud computing|unix|linux)|حاسب|حاسوب|شبكات|نظم التشغيل|أنظمة التشغيل|قواعد البيانات|أمن سيبراني|الأمن السيبراني|ذكاء اصطناعي|نظم المعلومات/i,
  ],
  [
    'natural_science',
    /\b(biology|chemistry|physics|geology|ecology|biochemistry|microbiology|genetics|astronomy|environmental science|botany|zoology|earth science)|أحياء|كيمياء|فيزياء|جيولوجيا|علم البيئة|كيمياء حيوية|أحياء دقيقة|وراثة|فلك/i,
  ],
  [
    'engineering',
    /\b(engineering|mechanical|electrical|civil|thermodynamics|circuits?|structural|control systems|fluid mechanics|electronics|manufacturing|industrial engineering)|هندسة|كهربائية|ميكانيكية|مدنية|ديناميكا حرارية|دوائر|إلكترونيات/i,
  ],
  [
    'health',
    /\b(medicine|medical|nursing|pharmacy|pharmacology|anatomy|physiology|pathology|dentistry|dental|clinical|public health|radiology|physiotherapy|nutrition|epidemiology|surgery)|طب|تمريض|صيدلة|علم الأدوية|تشريح|علم وظائف|علم الأمراض|أسنان|سريري|صحة عامة|أشعة|علاج طبيعي|تغذية/i,
  ],
  [
    'business',
    /\b(business|management|marketing|accounting|finance|financial|economics?|entrepreneurship|supply chain|human resources|e-commerce|banking|investment)|إدارة|تسويق|محاسبة|مالية|اقتصاد|ريادة|سلاسل الإمداد|موارد بشرية|مصرفية|استثمار/i,
  ],
  [
    'social_science',
    /\b(psychology|sociology|education|pedagogy|political science|anthropology|social work|communication|media studies|criminology)|علم النفس|علم الاجتماع|تربية|التربية|علوم سياسية|خدمة اجتماعية|إعلام|اتصال/i,
  ],
  [
    'humanities',
    /\b(history|literature|philosophy|religion|religious studies|islamic (studies|culture)|arts?|archaeology|ethics|cultural studies)|تاريخ|أدب|فلسفة|ثقافة إسلامية|دراسات إسلامية|فنون|آثار|أخلاقيات/i,
  ],
  [
    'law',
    /\b(law|legal|jurisprudence|criminal|contracts?|constitutional|sharia|fiqh|legislation|regulations)|قانون|أنظمة|نظام|فقه|شريعة|أصول الفقه|حقوق|تشريع/i,
  ],
  [
    'language',
    /\b(english language|grammar|linguistics|translation|writing skills|reading skills|vocabulary|phonetics|esl|efl|language skills)|لغة|نحو|صرف|ترجمة|لسانيات|مهارات الكتابة|مهارات القراءة/i,
  ],
];

const CODE_LINE_RE =
  /^\s*(def |class |public |private |protected |static |#include|import |from \S+ import|for\s*\(|while\s*\(|if\s*\(|return\b|SELECT\b|INSERT\b|UPDATE\b|CREATE TABLE|\$ |>>> |int |void |printf|cout|System\.out|console\.log|function\b|let |const |var |print\()|[;{}]\s*$/m;
const MATH_RE = /[=∑∫√≤≥±∞π∂Δ]|\\frac|\\sum|\\int|\^[0-9a-z]|\b(lim|dx|dy|log|ln|sin|cos)\b/g;

function codeLines(excerpts: StudioExcerpt[]): number {
  let count = 0;
  for (const excerpt of excerpts.slice(0, 40)) {
    for (const line of excerpt.content.split('\n')) if (CODE_LINE_RE.test(line)) count++;
  }
  return count;
}

function mathDensity(excerpts: StudioExcerpt[]): number {
  const text = excerpts
    .slice(0, 40)
    .map((excerpt) => excerpt.content)
    .join('\n');
  if (!text.length) return 0;
  return ((text.match(MATH_RE)?.length ?? 0) * 1000) / text.length;
}

export function isDisciplineId(value: unknown): value is DisciplineId {
  return typeof value === 'string' && (DISCIPLINE_IDS as readonly string[]).includes(value);
}

/**
 * Classifies the material into a discipline profile from the course metadata,
 * the analyst's labels and signals in the reference text (code, math density).
 * The analyst's own choice wins when it named a valid profile.
 */
export function classifyDiscipline(
  input: StudioInput,
  analysis: Partial<StudioAnalysis> | null,
  excerpts: StudioExcerpt[],
): DisciplineId {
  if (analysis && isDisciplineId(analysis.profile) && analysis.profile !== 'general') return analysis.profile;
  const scores = new Map<DisciplineId, number>();
  const score = (text: unknown, weight: number) => {
    if (typeof text !== 'string' || !text) return;
    for (const [id, pattern] of KEYWORDS) {
      if (pattern.test(text)) scores.set(id, (scores.get(id) ?? 0) + weight);
    }
  };
  // What this topic is about outweighs where the course is taught.
  score(analysis?.discipline, 4);
  score(analysis?.subfield, 3);
  score(analysis?.field, 2);
  score(input.topicTitle, 2);
  score(input.courseTitle, 2);
  score(input.department, 1);
  score(input.courseDescription, 1);

  const types = (analysis?.materialTypes ?? []).map((type) => type.toLowerCase());
  const bump = (id: DisciplineId, weight: number) => scores.set(id, (scores.get(id) ?? 0) + weight);
  if (types.includes('programming')) bump('programming', 3);
  if (types.includes('clinical')) bump('health', 3);
  if (types.includes('mathematical')) bump('mathematics', 1);
  if (types.includes('experimental')) bump('natural_science', 1);
  const lines = codeLines(excerpts);
  if (lines >= 12) bump('programming', 3);
  else if (lines >= 5) bump('computing', 1);
  if (mathDensity(excerpts) > 8) bump('mathematics', 2);

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length || ranked[0][1] < 2) return 'general';
  const [best] = ranked[0];
  // Systems courses that are mostly code are taught like programming courses.
  if (best === 'computing' && (scores.get('programming') ?? 0) >= ranked[0][1] - 1 && lines >= 12) {
    return 'programming';
  }
  return best;
}

export function disciplineProfile(id: unknown): DisciplineProfile {
  return isDisciplineId(id) ? DISCIPLINES[id] : DISCIPLINES.general;
}

/** Discipline section shared by the planning and writing prompts. */
export function disciplineBlock(profile: DisciplineProfile): string {
  return `Discipline profile: ${profile.label}. Signature evidence: ${profile.evidence} — at least ${Math.round(
    profile.minShare * 100,
  )}% of the core content slides must carry it.
Discipline practice:
${profile.rules.map((rule) => `- ${rule}`).join('\n')}`;
}

/** One-line discipline check for the inspector, verifier and reviewer. */
export function disciplineAudit(profile: DisciplineProfile): string {
  return `Discipline (${profile.label}): ${profile.audit} The deck should carry ${profile.evidence} on at least ${Math.round(
    profile.minShare * 100,
  )}% of its core slides.`;
}

function coreItems(outline: StudioOutlineItem[]) {
  return outline.filter((item) => CORE_TYPES.has(item.type.toUpperCase()));
}

/**
 * Raises the outline to the profile's evidence quota: plain CONTENT items whose
 * title or intent clearly calls for the field's evidence become signature slides
 * (CODE for programming, FORMULA for mathematics, a diagram for sciences…).
 */
export function enforceDisciplineOutline(
  outline: StudioOutlineItem[],
  profile: DisciplineProfile,
): { outline: StudioOutlineItem[]; changed: number[] } {
  const core = coreItems(outline);
  const retype = profile.retype;
  const need = Math.ceil(core.length * profile.minShare) - core.filter((item) => profile.plans(item)).length;
  if (!retype || need <= 0) return { outline, changed: [] };
  const candidates = core.filter(
    (item) =>
      item.type.toUpperCase() === 'CONTENT' &&
      item.visual.kind === 'none' &&
      retype.match.test(`${item.title} ${item.intent}`),
  );
  const changed = new Set(candidates.slice(0, need).map((item) => item.index));
  if (!changed.size) return { outline, changed: [] };
  return {
    outline: outline.map((item) =>
      changed.has(item.index)
        ? {
            ...item,
            type: retype.type,
            layout: retype.layout,
            visual: retype.visual === 'mermaid' ? { kind: 'mermaid', idea: item.intent } : item.visual,
          }
        : item,
    ),
    changed: [...changed].sort((a, b) => a - b),
  };
}

/**
 * Deck-level discipline check: when too few core slides carry the field's
 * evidence, the most suitable text-only slides are flagged for the optimizer.
 */
export function disciplineFindings(slides: StudioSlide[], profile: DisciplineProfile): StudioQaFinding[] {
  const core = slides
    .map((slide, index) => ({ slide, index }))
    .filter(({ slide }) => CORE_TYPES.has(String(slide.type ?? '').toUpperCase()));
  if (core.length < 3) return [];
  const carrying = core.filter(({ slide }) => profile.carries(slide)).length;
  const need = Math.ceil(core.length * profile.minShare) - carrying;
  if (need <= 0) return [];
  const match = profile.retype?.match;
  const candidates = core
    .filter(({ slide }) => !profile.carries(slide))
    .sort((a, b) => {
      const text = (slide: StudioSlide) => `${slide.title ?? ''} ${(slide.bullets ?? []).join(' ')}`;
      const fit = (slide: StudioSlide) => (match?.test(text(slide)) ? 0 : 1);
      return fit(a.slide) - fit(b.slide) || a.index - b.index;
    });
  return candidates.slice(0, need).map(({ index }) => ({
    slide: index + 1,
    severity: 'medium',
    category: 'pedagogy',
    message: `This ${profile.label.toLowerCase()} deck has too little ${profile.evidence} (${carrying}/${core.length} core slides); give this slide that evidence instead of plain bullets.`,
    source: 'auto',
  }));
}
