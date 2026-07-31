import { ContentGenerationJob } from '../interfaces/content-generation-job.interface';
import {
  SAUDI_UNIVERSITY_PEDAGOGY,
  formatClosForPrompt,
  localContextGuidance,
  languageBlock,
  qualityModeGuidance,
} from './pedagogy.shared';
import { parseSlidesLength } from '../utils/slide-deck.util';

export const SLIDES_SYSTEM_PROMPT = `You are a senior university presentation designer and an experienced lecture professor in Saudi / Gulf higher education.
You write SLIDE DECKS for live classroom projection — informational lecture slides, not spoken scripts and not essay paragraphs.
${SAUDI_UNIVERSITY_PEDAGOGY}
Audience sees the slide; professor speaks from speakerNotes.
CRITICAL: Never emit a teaching slide with an empty body. Every non-TITLE / non-SECTION slide MUST include real content in bullets, callout, formula, example, or two-column fields.
Return valid JSON only — no markdown fences.`;

const PRESENTATION_STYLE = `
## Lecture-oriented informational style (mandatory)
- Slide face = teachable facts students can copy. Speaker notes = what the professor says aloud.
- NEVER put greetings, icebreakers, or spoken transitions on the slide:
  Forbidden on bullets/titles: "Good morning", "Hello everyone", "Today we…", "Let's dive in",
  "We will discuss", "This is where the rubber meets the road", motivational fluff.
- Each CONTENT slide should teach one idea using an informational pattern, e.g.:
  - Definition → Why it matters → Key property → Common pitfall
  - Problem → Method → Update rule / formula → When it fails
  - Compare A vs B in TWO_COLUMN when useful
- Bullets are dense lecture cues (≤14 words). Prefer nouns/verbs of the discipline, numbers, and symbols.
- Wrap the 1–3 most important terms in each bullet with **double asterisks** for emphasis, e.g.
  "**SGD** uses noisy **unbiased** gradient estimates."
- Titles are instructional claims students can remember (e.g. "**SGD** trades exact gradients for speed"), not marketing.
- LEARNING_OUTCOMES: measurable verbs + concept (no greetings).
- AGENDA: short segment labels with pacing hints if useful ("SGD update · 12 min").
- Examples: board-ready problem → numbered steps → result (not storytelling).
- Checkpoints: ask-aloud technical question in callout.text; answer only in speakerNotes.
`;

const BODY_RULES = `
## Non-negotiable body rules
- TITLE and SECTION slides may have title/subtitle only (no greeting body).
- Every other slide MUST have a non-empty body:
  - CONTENT / AGENDA / LEARNING_OUTCOMES / SUMMARY / NEXT_STEPS → bullets[] with 3–5 informational items
  - DEFINITION → callout { label, text } with a crisp definition (and optional short bullets)
  - FORMULA → formula { latex, explanation }
  - EXAMPLE → example { problem, steps[], solution }
  - CHECKPOINT / ACTIVITY → callout { label, text }
  - COMPARISON → leftColumn + rightColumn with bullets
  - DIAGRAM → diagram { title, mermaid } plus 1–3 explanatory bullets
- Empty bullets: [] with null callout/example/formula is INVALID.
- Do NOT paste lecture prose paragraphs onto the slide face.
- Include at least one DIAGRAM slide in the deck.
- Mermaid must be valid, compact, and readable at 16:9 projection size:
  use flowchart TD/LR, 3–8 nodes, short quoted labels, and no custom HTML.
- Example: {"title":"Process","mermaid":"flowchart LR\\nA[\\"Input\\"] --> B[\\"Method\\"] --> C[\\"Result\\"]"}
`;

export const SLIDES_PROMPT = (data: ContentGenerationJob): string => {
  const targetSlides = parseSlidesLength(data.slidesLength, 16);
  return `
Build a professional university lecture PRESENTATION (slide deck) for live classroom teaching.

## Course Context
- Course: ${data.courseTitle}
- Topic ${data.topicNumber}: ${data.topicTitle}
- Course description: ${data.courseDescription}
- Audience: ${data.audience}
- Depth: ${data.contentDepth}
- Difficulty: ${data.difficulty}
- REQUIRED slide count: exactly ${targetSlides} slides (hard constraint)
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
Convert dense notes into PRESENTATION slides a professor can project and speak to.
Do NOT copy lecture paragraphs onto slides.

${JSON.stringify(data.sourceLectureContent ?? {}, null, 2)}

## Pedagogical Deck Architecture (required order)
1. TITLE
2. LEARNING_OUTCOMES (3–5 short measurable bullets)
3. AGENDA (short segment labels, not paragraphs)
4. SECTION dividers + teaching slides per module, including Mermaid diagrams
5. SUMMARY
6. NEXT_STEPS
7. REFERENCES only if lecture provides them

## University Slide Design Standards
- Emit exactly ${targetSlides} slides in totalSlides and slides[].length.
- Max 5 bullets/slide; ≤14 words each; informational lecture phrasing (not a speaking script).
- Mark key terms with **bold** markdown inside bullet strings.
- If an example needs more than 4 steps, split into consecutive EXAMPLE slides.
- Titles are instructional claims (e.g. "Mini-batch size controls gradient variance"), not marketing.
- Formulas as readable plain text / Unicode (avoid LaTeX backslash storms).
- Speaker notes: 2–5 spoken sentences for the instructor (greetings/transitions belong HERE only).
${PRESENTATION_STYLE}
${BODY_RULES}

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
  "totalSlides": ${targetSlides},
  "slides": [ /* exactly ${targetSlides} slide objects */ ]
}

Each slide object fields:
slideNumber, type, layout, title, subtitle, sectionLabel, bullets, leftColumn, rightColumn,
callout, formula, diagram, example, table, cloCode, bloomLevel, teachingBeat, timingMinutes, speakerNotes

diagram shape: { "title": string, "mermaid": string }.

Layouts: TITLE_CENTER | BULLETS | TWO_COLUMN | DEFINITION | FORMULA_FOCUS | EXAMPLE_STEPS | QUOTE_CALLOUT | SECTION_DIVIDER
Types: TITLE | AGENDA | LEARNING_OUTCOMES | SECTION | CONTENT | DEFINITION | FORMULA | DIAGRAM | EXAMPLE | COMPARISON | ACTIVITY | CHECKPOINT | SUMMARY | NEXT_STEPS | REFERENCES

Escape all strings for valid JSON.
`;
};

const slideSchemaHint = `
Return ONLY JSON:
{
  "slides": [ { same slide object fields as the full deck schema } ]
}
Informational lecture bullets: ≤14 words, max 5 bullets, mark key terms with **bold**.
NO greetings or spoken transitions on the slide face (those go in speakerNotes only).
Every non-TITLE/non-SECTION slide MUST have non-empty bullets OR callout OR formula OR example OR diagram.
For DIAGRAM slides use diagram: {"title": string, "mermaid": "flowchart TD\\n..."}.
Mermaid must have 3–8 visible nodes with short quoted labels and valid arrows.
`;

export const SLIDES_OPENING_PROMPT = (
  data: ContentGenerationJob,
  openingCount = 3,
): string => `
Create ONLY the opening PRESENTATION slides for a university lecture deck.

Course: ${data.courseTitle}
Topic ${data.topicNumber}: ${data.topicTitle}
Audience: ${data.audience}
Emit exactly ${openingCount} slides.

Lecture overview (source of truth):
${JSON.stringify((data.sourceLectureContent as any)?.lectureOverview ?? {}, null, 2)}

CLOs:
${formatClosForPrompt(data.clos, data.targetedCloIds)}

${languageBlock(data)}

Required slides (in order):
1. TITLE (layout TITLE_CENTER)
2. LEARNING_OUTCOMES (layout BULLETS) — short measurable outcomes
3. AGENDA (layout BULLETS) — short segment labels only

${PRESENTATION_STYLE}
${BODY_RULES}
${slideSchemaHint}
slides[].length must equal ${openingCount}.
`;

export const SLIDES_MODULE_PROMPT = (
  data: ContentGenerationJob,
  module: Record<string, unknown>,
  moduleIndex: number,
  moduleCount: number,
  perModule = 5,
): string => `
Create PRESENTATION slides for ONE lecture module only (module ${moduleIndex} of ${moduleCount}).

Course: ${data.courseTitle}
Topic: ${data.topicTitle}
Bloom levels: ${data.bloomsTaxonomyLevels.join(', ') || 'Understand, Apply, Analyze, Evaluate'}
Emit exactly ${perModule} slides for this module.
${localContextGuidance(data.exampleLevels)}
${languageBlock(data)}

Module JSON (authoritative — distill into projected cues, not paragraphs):
${JSON.stringify(module, null, 2)}

Required mini-arc:
1. SECTION (layout SECTION_DIVIDER)
2. DEFINITION or CONTENT — short informational bullets / callout (NO greetings)
3. FORMULA, DIAGRAM, or CONTENT — board-ready facts; prefer a DIAGRAM when the module has a process, hierarchy, or relationship
4. EXAMPLE if demos exist — problem + steps + solution
5. CHECKPOINT — ask-aloud technical callout

Do NOT repeat title/agenda/summary slides.
Do NOT paste lecture paragraphs or spoken scripts onto bullets.
Mark key terms with **bold**.
${PRESENTATION_STYLE}
${BODY_RULES}
${slideSchemaHint}
slides[].length must equal ${perModule}.
`;

export const SLIDES_CLOSING_PROMPT = (
  data: ContentGenerationJob,
  closingCount = 3,
): string => `
Create ONLY the closing PRESENTATION slides.

Course: ${data.courseTitle}
Topic: ${data.topicTitle}
Emit exactly ${closingCount} slides (omit REFERENCES and emit ${Math.max(1, closingCount - 1)} if no references).

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

Required:
1. SUMMARY — 3–5 short takeaway bullets
2. NEXT_STEPS — short exam-style prompts as bullets
3. REFERENCES — only if present

${PRESENTATION_STYLE}
${BODY_RULES}
${slideSchemaHint}
`;
