import type { SlideDeckSlide } from 'src/topic-content/utils/slide-deck.util';
import type { SlideTemplate } from './slide-studio.templates';
import type { DisciplineId } from './utils/discipline-profile.util';

export type StudioLanguage = 'ar' | 'en';

export type StudioChapterSelection = {
  referenceIndex: number;
  chapterIndices: number[];
};

export type StudioClo = {
  code: string;
  category: string | null;
  description: string;
  linked: boolean;
};

/** What the cover slide shows, resolved from the course, its university and the instructor. */
export type StudioCover = {
  universityName: string | null;
  /** Public path or URL of the university logo, e.g. `/universities/najran.png`. */
  universityLogo: string | null;
  college: string | null;
  courseTitle: string;
  courseCode: string | null;
  topicNumber: number;
  topicTitle: string;
  academicYear: string | null;
  /** Display label in the deck language, e.g. "First semester". */
  semester: string | null;
  instructorName: string | null;
};

/** Everything the graph needs that comes from the request + database. */
export type StudioInput = {
  sessionId: string;
  tenantId: number;
  userId: number | null;
  courseId: number;
  topicId: number;
  courseTitle: string;
  courseCode: string | null;
  courseDescription: string | null;
  courseLevel: string | null;
  department: string | null;
  topicTitle: string;
  topicNumber: number;
  clos: StudioClo[];
  slideCount: number;
  selections: StudioChapterSelection[];
  language: StudioLanguage;
  /** Institution templates available to the designer (absent in older sessions). */
  customTemplates?: SlideTemplate[];
  /** Cover slide data (absent in older sessions). */
  cover?: StudioCover;
};

export type StudioExcerpt = {
  referenceIndex: number;
  referenceTitle: string;
  chapterIndex: number;
  chapterName: string;
  content: string;
  similarity: number | null;
};

export type StudioFigure = {
  /** Stable key used by the agents, e.g. `r0-fig-12`. */
  key: string;
  referenceIndex: number;
  referenceTitle: string;
  caption: string;
  pageNumber: number;
  filePath: string;
  mimeType: string;
};

export type StudioContext = {
  mode: 'vector' | 'fulltext' | 'none';
  excerpts: StudioExcerpt[];
  figures: StudioFigure[];
  chapters: Array<{
    referenceIndex: number;
    referenceTitle: string;
    chapterIndex: number;
    chapterName: string;
  }>;
};

/** How much of a CLO concept the selected chapter can actually teach. */
export type CloCoverageStatus = 'covered' | 'partial' | 'not_covered';

/** One concept/skill carved out of a CLO and mapped to the chapter. */
export type StudioCloComponent = {
  id: string;
  cloCode: string;
  label: string;
  status: CloCoverageStatus;
  evidence: string;
};

/** Teaching-arc phase for a plan section (PO lecture structure). */
export type LecturePhase =
  | 'title'
  | 'clo_scope'
  | 'roadmap'
  | 'introduction'
  | 'body'
  | 'summary'
  | 'knowledge_check'
  | 'references';

export type StudioAnalysis = {
  /** Discipline profile that drives evidence types and teaching rules. */
  profile: DisciplineId;
  field: string;
  discipline: string;
  subfield: string;
  materialTypes: string[];
  audienceLevel: string;
  keyConcepts: string[];
  visualStrategy: string;
  summary: string;
  /** CLO parts vs selected chapter — honest scope for this lecture. */
  cloComponents: StudioCloComponent[];
};

export type StudioPlanSection = {
  id: string;
  title: string;
  goal: string;
  cloCodes: string[];
  slideCount: number;
  keyPoints: string[];
  visuals: string[];
  /** Lecture-arc phase; body sections hold the main teaching. */
  phase: LecturePhase;
};

export type StudioPlan = {
  title: string;
  approach: string;
  learningGoals: string[];
  sections: StudioPlanSection[];
  /** Copied from analysis at plan time so HITL can edit coverage honesty. */
  cloComponents?: StudioCloComponent[];
};

export type StudioTemplateSuggestion = {
  templateId: string;
  rationale: string;
  alternatives: Array<{ templateId: string; reason: string }>;
};

export type StudioVisual =
  | { kind: 'figure'; figureKey: string }
  | { kind: 'mermaid'; idea: string }
  | { kind: 'none' };

export type StudioOutlineItem = {
  index: number;
  sectionId: string;
  type: string;
  layout: string;
  title: string;
  intent: string;
  cloCode: string | null;
  visual: StudioVisual;
};

export type StudioVisualSource = {
  slide: number;
  classification: 'textbook' | 'ai_generated' | 'none' | 'not_verified';
  description: string;
  figureKey?: string | null;
  pageNumber?: number | null;
};

export type StudioReview = {
  score: number;
  summary: string;
  cloCoverage: Array<{ code: string; slides: number[] }>;
  /** Per-component coverage honesty (guide §8). */
  cloComponentCoverage?: Array<{
    id: string;
    cloCode: string;
    label: string;
    status: CloCoverageStatus;
    slides: number[];
    note: string;
  }>;
  visualSources?: StudioVisualSource[];
  issues: Array<{ slide: number | null; severity: string; message: string }>;
};

export type StudioSlide = SlideDeckSlide;

export type StudioQaFinding = {
  /** 1-based slide number. */
  slide: number;
  severity: 'low' | 'medium' | 'high';
  category: string;
  message: string;
  source: 'auto' | 'ai';
};

/** Inspector → optimizer loop state. `targets`/`optimized` are 0-based slide indices. */
export type StudioQa = {
  pass: number;
  draftScore: number | null;
  findings: StudioQaFinding[];
  initialCount: number;
  targets: number[];
  optimized: number[];
  /** Slides rewritten in the last optimizer round, re-verified by the next inspection. */
  recheck?: number[];
  /** The reviewer already sent slides back once; later inspections only report. */
  reviewRevised?: boolean;
};

export type StudioInterrupt =
  | { kind: 'plan_review'; plan: StudioPlan; revision: number }
  | {
      kind: 'template_review';
      suggestion: StudioTemplateSuggestion;
    }
  | { kind: 'outline_review'; outline: StudioOutlineItem[]; revision: number };

export type StudioResume =
  | { kind: 'plan_review'; action: 'confirm'; plan?: StudioPlan }
  | { kind: 'plan_review'; action: 'revise'; feedback: string; plan?: StudioPlan }
  | {
      kind: 'template_review';
      action: 'confirm';
      templateId: string;
      /** Attached by the service when an institution template is chosen. */
      customTemplate?: SlideTemplate;
    }
  | {
      kind: 'outline_review';
      action: 'confirm';
      outline?: StudioOutlineItem[];
    }
  | { kind: 'outline_review'; action: 'revise'; feedback: string };

export type StudioAgent =
  | 'researcher'
  | 'analyst'
  | 'planner'
  | 'designer'
  | 'outliner'
  | 'writer'
  | 'illustrator'
  | 'inspector'
  | 'optimizer'
  | 'reviewer'
  | 'publisher';

/** Events written by graph nodes on the `custom` stream (sent as SSE). */
export type StudioEvent =
  | {
      event: 'activity';
      data: {
        agent: StudioAgent;
        status: 'start' | 'done' | 'info';
        message: string;
        model?: string;
      };
    }
  | { event: 'context'; data: StudioContextSummary }
  | { event: 'analysis'; data: StudioAnalysis }
  | { event: 'plan_partial'; data: StudioPlan }
  | { event: 'template_suggestion'; data: StudioTemplateSuggestion }
  | { event: 'outline_item'; data: StudioOutlineItem }
  | { event: 'outline'; data: StudioOutlineItem[] }
  | { event: 'slides_init'; data: { total: number; templateId: string } }
  | { event: 'slide_writing'; data: { index: number } }
  | { event: 'slide'; data: { index: number; slide: StudioSlide } }
  | { event: 'qa'; data: StudioQa }
  | { event: 'review'; data: StudioReview }
  | { event: 'done'; data: { deck: Record<string, unknown> } };

export type StudioContextSummary = {
  mode: StudioContext['mode'];
  excerptCount: number;
  chapters: StudioContext['chapters'];
  figures: Array<Omit<StudioFigure, 'mimeType'>>;
};

export function summarizeContext(context: StudioContext): StudioContextSummary {
  return {
    mode: context.mode,
    excerptCount: context.excerpts.length,
    chapters: context.chapters,
    figures: context.figures.map((figure) => ({
      key: figure.key,
      referenceIndex: figure.referenceIndex,
      referenceTitle: figure.referenceTitle,
      caption: figure.caption,
      pageNumber: figure.pageNumber,
      filePath: figure.filePath,
    })),
  };
}
