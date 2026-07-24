import { ContentGenerationJob } from '../interfaces/content-generation-job.interface';

export const SLIDES_SYSTEM_PROMPT = `You are a senior university instructional designer and an experienced professor.
You produce presentation decks that faculty can teach from immediately: clear structure, classroom pacing, rigorous content, and strong speaker notes.
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
- Bloom levels: ${data.bloomsTaxonomyLevels.join(', ') || 'Understand, Apply, Analyze'}
- Visual preference: ${data.visuals.join(', ') || 'Concept Diagrams, Process Flow'}
- Assessment styles to seed: ${data.assessmentIntegrations.join(', ') || 'Short Answers, Discussion Questions'}

## CLOs
${data.clos.map((c) => `- [${c.code}] ${c.description}`).join('\n') || '- (none provided)'}

### Priority CLO focus
${
  data.targetedCloIds.length
    ? data.targetedCloIds.map((id) => `- ${id}`).join('\n')
    : '- Emphasize CLOs most relevant to this topic'
}

## Source Lecture Content (authoritative)
Use this lecture as the single source of truth.
Do NOT invent a different syllabus, sequence, terminology, examples, objectives, or assessment focus.
Convert dense notes into teachable slides a professor can present.

${JSON.stringify(data.sourceLectureContent ?? {}, null, 2)}

## Pedagogical Deck Architecture (required order)
1. TITLE — course, topic, instructor-facing session identity
2. LEARNING_OUTCOMES — measurable outcomes aligned to CLOs/Bloom
3. AGENDA — 4–7 session segments with intended pacing
4. SECTION dividers before each major module/theme from the lecture
5. Teaching body for each module using a mini-arc:
   - DEFINITION / CONTENT (concept)
   - FORMULA or DIAGRAM when the lecture has formalism or structure
   - EXAMPLE with complete worked steps
   - CHECKPOINT or ACTIVITY (1 formative check)
6. SUMMARY — synthesis of key takeaways
7. NEXT_STEPS / take-home questions (exam-quality)
8. REFERENCES — only if the lecture provides references (otherwise omit)

## University Slide Design Standards
- Target ~18–28 slides for a substantial university topic (adjust up/down only if lecture is very short/long).
- One teaching idea per slide. Never dump a whole module onto one slide.
- Max 5 bullets per slide; each bullet ≤ 14 words; telegraphic academic phrasing.
- Titles are instructional, not marketing (e.g. "Deriving the Update Rule", not "Let's Dive In").
- Prefer action verbs tied to Bloom: Define, Distinguish, Derive, Compare, Apply, Critique.
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
