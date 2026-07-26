import { ContentGenerationJob } from '../interfaces/content-generation-job.interface';
import {
  SAUDI_UNIVERSITY_PEDAGOGY,
  formatClosForPrompt,
  localContextGuidance,
  languageBlock,
  qualityModeGuidance,
} from './pedagogy.shared';

export const SLIDES_SYSTEM_PROMPT = `You are a senior university instructional designer and an experienced professor teaching in Saudi / Gulf higher education.
You produce presentation decks that faculty can teach from immediately: clear structure, classroom pacing, rigorous content, and strong speaker notes.
${SAUDI_UNIVERSITY_PEDAGOGY}
Return valid JSON only — no markdown fences.`;

export const SLIDES_PROMPT = (data: ContentGenerationJob): string => `
Build a professional university lecture slide deck for live classroom teaching.

## Course Context
- Course: ${data.courseTitle}
- Topic ${data.topicNumber}: ${data.topicTitle}
- Course description: ${data.courseDescription}
- Audience: ${data.audience}
- Depth: ${data.contentDepth}
- Difficulty: ${data.difficulty}
- Bloom levels: ${data.bloomsTaxonomyLevels.join(', ') || 'Understand, Apply, Analyze, Evaluate'}
- Visual preference: ${data.visuals.join(', ') || 'Concept Diagrams, Process Flow'}
- Assessment styles to seed: ${data.assessmentIntegrations.join(', ') || 'Short Answers, Discussion Questions'}

- ${qualityModeGuidance(data.aiQualityMode)}

## CLOs (constructive alignment)
${formatClosForPrompt(data.clos, data.targetedCloIds)}

### Priority CLO focus
${
  data.targetedCloIds.length
    ? data.targetedCloIds.map((id) => `- ${id}`).join('\n')
    : '- Emphasize CLOs most relevant to this topic'
}

${localContextGuidance(data.exampleLevels)}

${languageBlock(data)}

## Source Lecture Content (authoritative)
Use this lecture as the single source of truth.
Do NOT invent a different syllabus, sequence, terminology, examples, objectives, or assessment focus.
Convert dense notes into teachable slides a professor can present.

${JSON.stringify(data.sourceLectureContent ?? {}, null, 2)}

## Pedagogical Deck Architecture (required order)
1. TITLE — course, topic, instructor-facing session identity
2. LEARNING_OUTCOMES — measurable outcomes aligned to CLOs/Bloom (show CLO codes)
3. AGENDA — 4–7 session segments with intended pacing
4. SECTION dividers before each major module/theme from the lecture
5. Teaching body for each module using a mini-arc:
   - DEFINITION / CONTENT (concept)
   - FORMULA or DIAGRAM when the lecture has formalism or structure
   - EXAMPLE with complete worked steps
   - CHECKPOINT or ACTIVITY (1 formative check mapped to a CLO)
6. SUMMARY — synthesis of key takeaways + CLO coverage reminder
7. NEXT_STEPS / take-home questions (exam-quality)
8. REFERENCES — only if the lecture provides references (otherwise omit)

## University Slide Design Standards
- Target ~18–28 slides for a substantial university topic (adjust up/down only if lecture is very short/long).
- One teaching idea per slide. Never dump a whole module onto one slide.
- Max 5 bullets per slide; each bullet ≤ 14 words; telegraphic academic phrasing.
- If an example needs more than 4 steps, emit consecutive EXAMPLE slides (Part 1/2, Part 2/2) instead of one overloaded slide.
- Titles are instructional, not marketing (e.g. "Deriving the Update Rule", not "Let's Dive In").
- Prefer action verbs tied to Bloom: Define, Distinguish, Derive, Compare, Apply, Evaluate, Critique.
- Include numerical worked examples whenever the lecture contains them; keep values exact.
- Formulas as readable plain text (no LaTeX backslash storms that break JSON). Prefer Unicode/math prose.
- Mermaid diagrams only when they clarify structure already present in the lecture; keep them short.
- Speaker notes are for the instructor: what to say, what to ask, what to write on the board, common misconception to preempt. 2–5 sentences.
- Put cloCode on concept/example/checkpoint slides when a CLO clearly maps.
- Set teachingBeat and timingMinutes so faculty can pace the session.
- Prefer layout hints that match content:
  - TITLE_CENTER for title
  - SECTION_DIVIDER for section breaks
  - BULLETS for standard exposition
  - TWO_COLUMN for comparisons/taxonomy splits
  - DEFINITION for key term slides
  - FORMULA_FOCUS for equations
  - EXAMPLE_STEPS for worked examples
  - QUOTE_CALLOUT for misconceptions / key warnings
- Avoid fluff: no motivational hype, no "overview of overview", no filler transition slides, no generic AI tips.
- Output is consumed by GradX's university PPTX template engine (navy/teal academic theme, footer with course + slide numbers).

## JSON Schema (return ONLY valid JSON)
{
  "deckMeta": {
    "courseTitle": string,
    "topicTitle": string,
    "topicNumber": number,
    "audience": string,
    "difficulty": string,
    "recommendedDurationMinutes": number,
    "learningOutcomes": [string],
    "designTheme": "UNIVERSITY_ACADEMIC"
  },
  "totalSlides": number,
  "slides": [
    {
      "slideNumber": number,
      "type": "TITLE" | "AGENDA" | "LEARNING_OUTCOMES" | "SECTION" | "CONTENT" | "DEFINITION" | "FORMULA" | "DIAGRAM" | "EXAMPLE" | "COMPARISON" | "ACTIVITY" | "CHECKPOINT" | "SUMMARY" | "NEXT_STEPS" | "REFERENCES",
      "layout": "TITLE_CENTER" | "BULLETS" | "TWO_COLUMN" | "DEFINITION" | "FORMULA_FOCUS" | "EXAMPLE_STEPS" | "QUOTE_CALLOUT" | "SECTION_DIVIDER",
      "title": string,
      "subtitle": string | null,
      "sectionLabel": string | null,
      "bullets": string[],
      "leftColumn": { "heading": string, "bullets": string[] } | null,
      "rightColumn": { "heading": string, "bullets": string[] } | null,
      "callout": { "label": string, "text": string } | null,
      "formula": { "latex": string, "explanation": string } | null,
      "diagram": { "title": string, "mermaid": string } | null,
      "example": {
        "problem": string,
        "steps": string[],
        "solution": string
      } | null,
      "table": {
        "headers": string[],
        "rows": string[][]
      } | null,
      "cloCode": string | null,
      "bloomLevel": string | null,
      "teachingBeat": "INTRODUCE" | "EXPLAIN" | "DEMONSTRATE" | "CHECK" | "SYNTHESIZE" | null,
      "timingMinutes": number | null,
      "speakerNotes": string
    }
  ]
}

## Quality Bar
Every CONTENT/DEFINITION slide must advance understanding.
Every EXAMPLE must be complete enough to teach from without opening the lecture notes.
Every CHECKPOINT/ACTIVITY must include a clear prompt the instructor can ask aloud; put the model answer in speakerNotes.
Escape all strings for valid JSON.
`;

const slideSchemaHint = `
Return ONLY JSON:
{
  "slides": [ { same slide object fields as the full deck schema } ]
}
Max 5 bullets/slide, ≤14 words each. One idea per slide. Include speakerNotes.
`;

export const SLIDES_OPENING_PROMPT = (data: ContentGenerationJob): string => `
Create ONLY the opening slides for a university lecture deck.

Course: ${data.courseTitle}
Topic ${data.topicNumber}: ${data.topicTitle}
Audience: ${data.audience}

Lecture overview (source of truth):
${JSON.stringify((data.sourceLectureContent as any)?.lectureOverview ?? {}, null, 2)}

CLOs:
${formatClosForPrompt(data.clos, data.targetedCloIds)}

${languageBlock(data)}

Required slides (in order):
1. TITLE
2. LEARNING_OUTCOMES (from lecture learningObjectives / CLOs)
3. AGENDA (4–7 segments from lecture modules / suggestedClassFlow)

${slideSchemaHint}
Emit 3–5 slides total for this opening block.
`;

export const SLIDES_MODULE_PROMPT = (
  data: ContentGenerationJob,
  module: Record<string, unknown>,
  moduleIndex: number,
  moduleCount: number,
): string => `
Create teaching slides for ONE lecture module only (module ${moduleIndex} of ${moduleCount}).

Course: ${data.courseTitle}
Topic: ${data.topicTitle}
Bloom levels: ${data.bloomsTaxonomyLevels.join(', ') || 'Understand, Apply, Analyze, Evaluate'}
${localContextGuidance(data.exampleLevels)}
${languageBlock(data)}

Module JSON (authoritative):
${JSON.stringify(module, null, 2)}

Required mini-arc for this module:
1. SECTION divider (module title)
2. DEFINITION or CONTENT (core concept)
3. FORMULA or DIAGRAM if present in the module; otherwise CONTENT
4. EXAMPLE with worked steps if appliedDemonstrations exist
5. CHECKPOINT or ACTIVITY from formativeChecks (model answer in speakerNotes)

Do NOT repeat title/agenda/summary slides.
${slideSchemaHint}
Emit 4–7 slides for this module.
`;

export const SLIDES_CLOSING_PROMPT = (data: ContentGenerationJob): string => `
Create ONLY the closing slides for a university lecture deck.

Course: ${data.courseTitle}
Topic: ${data.topicTitle}

Lecture closing context:
${JSON.stringify(
  {
    modules: ((data.sourceLectureContent as any)?.modules ?? []).map(
      (m: any, i: number) => ({
        moduleIndex: m?.moduleIndex ?? i + 1,
        title: m?.title,
        takeaways: m?.moduleKeyTakeaways,
      }),
    ),
    assessment: (data.sourceLectureContent as any)?.comprehensiveAssessment,
    references: (data.sourceLectureContent as any)?.providedReferences,
  },
  null,
  2,
)}

${languageBlock(data)}

Required slides (in order):
1. SUMMARY — key takeaways across modules
2. NEXT_STEPS — exam-quality take-home prompts
3. REFERENCES — only if references exist; otherwise omit

${slideSchemaHint}
Emit 2–4 slides.
`;
