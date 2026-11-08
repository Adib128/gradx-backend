import { contentLanguageGuidance } from 'src/topic-content/utils/content-language.util';
import { templateCatalogForPrompt, type SlideTemplate } from '../slide-studio.templates';
import {
  DISCIPLINES,
  disciplineAudit,
  disciplineBlock,
  disciplineProfile,
  type DisciplineProfile,
} from '../utils/discipline-profile.util';
import { estimateSlideFit } from '../utils/slide-fit.util';
import { cloComponentsBlock } from '../utils/lecture-arc.util';
import { rankedFiguresBlock } from '../utils/figure-rank.util';
import type {
  StudioAnalysis,
  StudioContext,
  StudioExcerpt,
  StudioFigure,
  StudioInput,
  StudioOutlineItem,
  StudioPlan,
  StudioPlanSection,
  StudioQaFinding,
  StudioSlide,
} from '../slide-studio.types';

export type PromptPair = { system: string; user: string };

const TEAM = `You are part of GradX Slide Studio, a multi-agent team that builds university lecture slide decks
(Saudi higher-education context, NCAAA constructive alignment: every slide serves a Course Learning Outcome).
University faculty present these decks as their own, so every slide must read like the work of an experienced,
meticulous professor: accurate, precise, visually clean and ready to project without edits.`;

/** Shared standard for everything students read (outline titles, slides, rewrites). */
const PROFESSIONAL_STYLE = `Professional standard (assertion-evidence slide design):
- Headline = the slide's claim: a specific, complete statement of 5-10 words in sentence case, no final period
  ("Pipes connect one program's output to the next"), never a topic label ("Pipes", "Overview", "Introduction",
  "Background", "Key concepts", "Mathematical foundations").
- The body is the evidence for that claim: a figure, diagram, worked example, table or tight bullets — show, then tell.
- One idea per slide. If the idea needs more than ~60 words of on-slide text, it belongs on two slides.
- Bullets: parallel grammar, start with the key noun or verb, one **key term** in bold at most, either all fragments
  (no periods) or all full sentences on a slide. No filler ("It is important to note", "In this slide").
- Depth over breadth: each bullet teaches a mechanism, condition, trade-off, result or decision rule — not a catalogue
  of topic names. Prefer "why / when / how / so what" over "what is covered".
- Precision: concrete values with units, named cases and the reference's own terminology; define a term the first
  time it appears; never vague quantifiers ("many", "various", "several", "some") when the reference gives a number
  or a named set.
- Every line earns its place: a bullet states a fact, mechanism, cause, consequence or number — never only a topic
  name ("Process states") or a promise ("We will see how…", "Students will learn…").
- No hedging or meta-commentary about the slide itself ("not a complete list", "varies by system", "this slide shows",
  "as mentioned earlier"). State a limit only when the reference does, and then precisely (which systems, which condition).
- Show each idea in one form: a comparison is either two columns or a table, a process either a diagram or numbered
  bullets — never the same content twice on one slide.
- Expert voice: write as the course instructor, not as a textbook summary or AI overview. Prefer the field's standard
  notation and the reference's wording over paraphrase that softens meaning.
- Academic tone: neutral and confident; no hype words, exclamation marks or emojis.
- Accessibility: meaning never depends on colour alone; diagram labels ≤ 4 words.`;

/** Extra content-quality bar for writer / optimizer (keeps decks lecture-ready). */
const CONTENT_DEPTH = `Content depth (university lecture, not study notes):
- Teach the hard part: for every core concept, state the definition OR the governing rule, then the condition under
  which it holds, then one consequence students can use.
- Prefer reference-backed specificity: symbols, named theorems/algorithms, orders of growth, units, edge cases and
  common failure modes from the excerpts — never invent numbers or citations.
- Worked content beats description: when the CLO is Apply/Analyze, prefer EXAMPLE / FORMULA / CODE / COMPARISON over
  another plain CONTENT bullet slide.
- Visuals must earn the slide: bullets beside a figure/diagram say what to notice and why it matters for the claim,
  not "see the diagram".
- Speaker notes add teaching moves the slide omits (analogy, misconception, cold-call question, transition) — never
  a restatement of the bullets.
- Stay inside the section CLOs and the CLO-scoped excerpts; do not pad with neighbouring chapter topics.`;

/** Style exemplars from another field, so they shape form without leaking content. */
const EXEMPLARS = `Style exemplars (different course — copy the form, never the content):
{"n":7,"type":"DIAGRAM","layout":"BULLETS","title":"Enzymes lower the activation barrier, not ΔG","bullets":["**Activation energy** drops, so more collisions react at 37 °C","ΔG and the equilibrium position stay unchanged","Catalase speeds H₂O₂ breakdown about 10⁷-fold"],"diagram":{"title":"Two paths from substrate to product","mermaid":"flowchart LR\\nS[\\"Substrate\\"] --> T[\\"Uncatalysed\\\\nhigh barrier\\"] --> P[\\"Product\\"]\\nS --> E[\\"Enzyme complex\\\\nlow barrier\\"] --> P"},"cloCode":"CLO 1.2","bloomLevel":"Understand","speakerNotes":"An enzyme does not change where a reaction ends up, only how fast it gets there. Compare the two paths: both start and finish at the same energy, so ΔG is identical, but the enzyme path crosses a much lower hill. Think of a mountain tunnel: the destination is the same, the climb is not. Next, we quantify this speed-up with the Michaelis–Menten model."}
{"n":12,"type":"EXAMPLE","layout":"EXAMPLE_STEPS","title":"A 10% price rise cuts demand by 15%","example":{"problem":"A café raises a latte from 20 to 22 SAR; daily sales fall from 400 to 340 cups. Is demand elastic?","steps":["%ΔQ = (340 − 400) / 400 = −15%","%ΔP = (22 − 20) / 20 = +10%","Ed = −15% / 10% = −1.5"],"solution":"|Ed| = 1.5 > 1, so demand is elastic: revenue falls from 8,000 to 7,480 SAR."},"cloCode":"CLO 2.1","bloomLevel":"Apply","speakerNotes":"Walk through the three steps on the board before revealing the result. Ask students to predict revenue first. Elastic demand means the percentage drop in quantity outweighs the price rise, so revenue falls. Next, we see which goods tend to be elastic and why."}`;

const CODE_EXEMPLAR = `{"n":9,"type":"CODE","layout":"BULLETS","title":"A dictionary counts words in one pass","bullets":["**get(w, 0)** returns 0 for a word not seen yet","Each word costs one O(1) lookup, so the loop is O(n)"],"code":{"language":"python","source":"text = \\"to be or not to be\\"\\ncounts = {}\\nfor w in text.split():\\n    counts[w] = counts.get(w, 0) + 1\\nprint(counts)","highlight":[4],"output":"{'to': 2, 'be': 2, 'or': 1, 'not': 1}","caption":"word_count.py"},"cloCode":"CLO 2.2","bloomLevel":"Apply","speakerNotes":"Read line 4 aloud: look the word up, default to zero, add one. Ask students what happens without the default. Next, we replace this loop with collections.Counter."}`;

function exemplars(profile: DisciplineProfile) {
  return profile.id === 'programming' || profile.id === 'computing' ? `${EXEMPLARS}\n${CODE_EXEMPLAR}` : EXEMPLARS;
}

const SLIDE_TYPES =
  'TITLE | INTRODUCTION | AGENDA | LEARNING_OUTCOMES | SECTION | CONTENT | DEFINITION | FORMULA | CODE | DIAGRAM | EXAMPLE | COMPARISON | ACTIVITY | CHECKPOINT | SUMMARY | CONCLUSION | REFERENCES';
const SLIDE_LAYOUTS =
  'TITLE_CENTER | BULLETS | TWO_COLUMN | DEFINITION | FORMULA_FOCUS | EXAMPLE_STEPS | QUOTE_CALLOUT | SECTION_DIVIDER';

function outputLanguageOptions(input: StudioInput) {
  const prefs = input.preferences;
  if (prefs?.language === 'other' && prefs.otherLanguageName) {
    return { otherLanguageName: prefs.otherLanguageName };
  }
  return undefined;
}

function studioLanguageGuidance(input: StudioInput) {
  return contentLanguageGuidance(input.language, outputLanguageOptions(input));
}

function preferencesBlock(input: StudioInput) {
  const prefs = input.preferences;
  if (!prefs) return null;
  const depth =
    prefs.contentDepth === 'basic'
      ? 'keep explanations short and introductory'
      : prefs.contentDepth === 'detailed'
        ? 'include definitions, derivations, and edge cases where useful'
        : 'balance overview with enough detail to teach the CLO';
  const visuals =
    prefs.visualPreference === 'diagrams'
      ? 'prefer process/flow/structure diagrams'
      : prefs.visualPreference === 'infographics'
        ? 'prefer comparison charts, cards, and visual summaries'
        : 'mix diagrams and visual summaries';
  const examples =
    prefs.examples === 'basic'
      ? 'use short textbook-style examples'
      : prefs.examples === 'real_world'
        ? 'use realistic workplace or domain scenarios'
        : 'use practical applied classroom examples';
  const style =
    prefs.presentationStyle === 'modern'
      ? 'modern lecture tone with crisp claims'
      : prefs.presentationStyle === 'minimal'
        ? 'minimal text, high signal per slide'
        : 'classic academic lecture tone';
  const audience =
    prefs.audience === 'graduate'
      ? 'graduate / advanced students; assume prior fundamentals'
      : 'undergraduate students; explain unfamiliar terms';
  const languageLabel =
    prefs.language === 'ar'
      ? 'Arabic'
      : prefs.language === 'other'
        ? prefs.otherLanguageName || prefs.otherLanguage || 'other'
        : 'English';
  return [
    'Instructor preferences (MUST follow):',
    `- Audience: ${prefs.audience} (${audience})`,
    `- Content depth: ${prefs.contentDepth} (${depth})`,
    `- Presentation style: ${prefs.presentationStyle} (${style})`,
    `- Visual preference: ${prefs.visualPreference} (${visuals})`,
    `- Examples: ${prefs.examples} (${examples})`,
    `- Deck language: ${languageLabel}`,
    `- Speaker notes: ${prefs.speakerNotes ? 'required on every content slide' : 'omit speaker notes (use empty string)'}`,
    `- Slide count is fixed at ${input.slideCount}.`,
  ].join('\n');
}

function courseBlock(input: StudioInput) {
  const linked = input.clos.filter((clo) => clo.linked);
  const clos = (linked.length ? linked : input.clos)
    .map(
      (clo) =>
        `- ${clo.code}${clo.category ? ` (${clo.category})` : ''}: ${clo.description}`,
    )
    .join('\n');
  return [
    `Course: ${input.courseTitle}${input.courseCode ? ` (${input.courseCode})` : ''}`,
    input.department ? `Department: ${input.department}` : null,
    input.courseLevel ? `Level: ${input.courseLevel}` : null,
    input.courseDescription ? `Course description: ${input.courseDescription}` : null,
    `Topic ${input.topicNumber}: ${input.topicTitle}`,
    `Course learning outcomes${linked.length ? ' linked to this topic' : ''}:\n${clos || '- (none provided)'}`,
    preferencesBlock(input),
  ]
    .filter(Boolean)
    .join('\n');
}

export function excerptsBlock(excerpts: StudioExcerpt[], maxChars: number) {
  if (!excerpts.length) return 'No reference excerpts were selected; rely on standard academic knowledge of the topic.';
  const parts: string[] = [];
  let used = 0;
  for (const excerpt of excerpts) {
    const header = `### ${excerpt.referenceTitle} — ${excerpt.chapterName}`;
    const room = maxChars - used - header.length - 2;
    if (room < 400) break;
    const body = excerpt.content.trim().slice(0, room);
    parts.push(`${header}\n${body}`);
    used += header.length + body.length + 2;
  }
  return parts.join('\n\n');
}

export function figuresBlock(figures: StudioFigure[]) {
  if (!figures.length) return 'No reference figures are available.';
  return figures
    .map(
      (figure) =>
        `- ${figure.key}: ${figure.caption} (${figure.referenceTitle}, p. ${figure.pageNumber})`,
    )
    .join('\n');
}

function analysisBlock(analysis: StudioAnalysis | null) {
  if (!analysis) return '';
  return `Material analysis: profile=${disciplineProfile(analysis.profile).label}; field=${analysis.field}; discipline=${analysis.discipline}; subfield=${analysis.subfield}; material types=${analysis.materialTypes.join(', ')}; audience=${analysis.audienceLevel}.
Key concepts: ${analysis.keyConcepts.join(', ')}.
Visual strategy: ${analysis.visualStrategy}
${cloComponentsBlock(analysis.cloComponents)}`;
}

function planBlock(plan: StudioPlan) {
  return `Deck title: ${plan.title}
Approach: ${plan.approach}
Learning goals: ${plan.learningGoals.join(' | ')}
${cloComponentsBlock(plan.cloComponents)}
Sections:
${plan.sections
  .map(
    (section, index) =>
      `${index + 1}. [${section.id}|${section.phase}] ${section.title} — ${section.slideCount} slide(s); goal: ${section.goal}; CLOs: ${section.cloCodes.join(', ') || '-'}; key points: ${section.keyPoints.join(' / ')}; visuals: ${section.visuals.join(', ') || 'none'}`,
  )
  .join('\n')}`;
}

function templateBlock(template: SlideTemplate) {
  return `Template "${template.name.en}": density ${template.style.density}; tone: ${template.style.tone}; preferred layouts: ${template.style.preferredLayouts.join(', ')}; visuals: ${template.style.visualEmphasis}.`;
}

export function analystPrompt(input: StudioInput, context: StudioContext): PromptPair {
  return {
    system: `${TEAM}
You are the ANALYST agent. Classify the teaching material AND map CLO components to the selected chapter.
Return ONLY one compact JSON object (no markdown fences, no commentary). Keep cloComponents to at most 6 items.
{"profile": ${Object.keys(DISCIPLINES).map((id) => `"${id}"`).join('|')},
 "field": string, "discipline": string, "subfield": string,
 "materialTypes": string[],
 "audienceLevel": string, "keyConcepts": string[],
 "visualStrategy": string,
 "summary": string,
 "cloComponents": [{"id": string, "cloCode": string, "label": string,
   "status": "covered"|"partial"|"not_covered",
   "evidence": string}]}
CLO mapping rules:
- Split linked CLOs into a few components (action verb + concepts). Max 6 total.
- covered = chapter teaches it well; partial = introduced only; not_covered = not supported here.
- Never invent page numbers. Prefer textbook figures in visualStrategy when captions match.
Profiles (pick the one whose teaching evidence fits the material, not only the department name):
${Object.values(DISCIPLINES)
  .map((profile) => `- ${profile.id}: ${profile.label} — taught with ${profile.evidence}`)
  .join('\n')}
Choose programming when students write or read source code; computing for systems/theory courses (networks, OS,
databases, AI) where code is occasional; mathematics when results are derived and computed; general only when none fits.
${studioLanguageGuidance(input)}`,
    user: `${courseBlock(input)}

Reference excerpts (sample):
${excerptsBlock(context.excerpts, 12_000)}

Available reference figures:
${figuresBlock(context.figures.slice(0, 30))}`,
  };
}

export function plannerPrompt(
  input: StudioInput,
  context: StudioContext,
  analysis: StudioAnalysis | null,
  revision: { previous: StudioPlan; feedback: string } | null,
): PromptPair {
  return {
    system: `${TEAM}
You are the PLANNER agent (lead instructional designer). Design the teaching plan for a deck of EXACTLY ${input.slideCount} slides.

Output NDJSON: one JSON object per line, no prose, no code fences, no array brackets.
Line 1: {"type":"meta","title":string /* assertion about the lecture, not "Lecture on X" */,"approach":string /* pedagogy in 1-2 sentences */,"learningGoals":string[] /* 3-5 measurable outcomes with Bloom verbs + object, only for CLO parts covered/partial in this lecture */,"cloComponents":[{"id","cloCode","label","status":"covered"|"partial"|"not_covered","evidence"}]}
Then one line per section, in teaching order:
{"type":"section","phase":"title"|"clo_scope"|"roadmap"|"introduction"|"body"|"summary"|"knowledge_check"|"references","title":string,"goal":string,"cloCodes":string[],"slideCount":integer,"keyPoints":string[] /* 2-5 assertion claims for body; short for frame phases */,"visuals":string[]}

Required lecture arc (phases, in this order):
1. title (1 slide) — cover from course data; visuals none
2. clo_scope (1 slide) — full original CLO + which components are covered / partial / not covered this lecture
3. roadmap (1 slide) — teaching order tied to chapter sections for covered/partial components only
4. introduction (1 slide) — context, importance, motivating question grounded in the chapter
5. body (several sections) — teach ONLY covered/partial CLO components; never invent not_covered topics
6. summary (1 slide) — takeaways + contribution to covered CLO parts only (do not claim the whole CLO)
7. knowledge_check (1 slide) — 3–5 questions only on content taught; answers belong in speaker notes later
8. references (1 slide, always last) — verified biblio; figure provenance filled later

Rules:
- The sum of slideCount over all sections MUST equal ${input.slideCount}.
- Copy/refine cloComponents from the analyst map; keep honesty about partial/not_covered.
- Body sections only: usually 3-6 thematic units; every body section maps to at least one CLO code.
- ONLY use CLO codes from the provided topic-linked list — never invent or pick unrelated course CLOs.
- Section titles for body are teachable units ("The PCB stores everything needed to resume a process"), not catalogue headings.
- keyPoints for body are assertion claims (mechanism, condition, result or misconception), 8-16 words each.
- Ground key points in the reference excerpts for covered/partial components; use textbook terminology.
- Budget depth: after a hard concept, allocate EXAMPLE / FORMULA / DIAGRAM / CODE before moving on.
- visuals: prefer "figure:<key>" from the figure list / shortlists when a textbook figure teaches the idea;
  otherwise "mermaid:<prompt>". Never present an AI diagram as a textbook figure.
  Also use "code:", "formula:", "example:", "table:" when the chapter supports them — do not force every type.
- Frame phases (title, clo_scope, roadmap, introduction, summary, knowledge_check, references) use visuals: [].
${disciplineBlock(disciplineProfile(analysis?.profile))}
${PROFESSIONAL_STYLE}
${studioLanguageGuidance(input)}`,
    user: `${courseBlock(input)}

${analysisBlock(analysis)}

Reference excerpts:
${excerptsBlock(context.excerpts, 40_000)}

Reference figures (key: caption):
${figuresBlock(context.figures)}

${rankedFiguresBlock(
  (analysis?.keyConcepts ?? []).slice(0, 8).map((concept, index) => ({
    id: `concept-${index + 1}`,
    title: concept,
    goal: concept,
    keyPoints: [concept],
    cloCodes: [],
  })),
  context.figures,
)}
${
  revision
    ? `
PREVIOUS PLAN:
${planBlock(revision.previous)}

INSTRUCTOR FEEDBACK — revise the plan accordingly, keep what was not criticised:
${revision.feedback}`
    : ''
}`,
  };
}

export function designerPrompt(
  input: StudioInput,
  analysis: StudioAnalysis | null,
  plan: StudioPlan,
): PromptPair {
  return {
    system: `${TEAM}
You are the DESIGNER agent. Choose the slide template that best fits the field, the material and the plan.
All built-in templates share the same lecture chrome (underline header, rounded graphic cards, Think-about-it, CLO bands). Pick on palette and writing style, not decoration.
Honor the instructor presentation-style preference from the course block (academic → Scholar/classic; modern → cleaner contemporary palettes; minimal → Swiss/Atlas-like sparse look) when it still fits the field.
Prefer an institution custom template when brand identity matters. Otherwise default to academic-classic (Scholar) for university lectures unless another template's field list is a clearly better match.
Templates:
${templateCatalogForPrompt(input.customTemplates)}

Return ONLY one JSON object:
{"templateId": string, "rationale": string /* 1-2 sentences addressed to the instructor */,
 "alternatives": [{"templateId": string, "reason": string}] /* exactly 2 other good options */}
${studioLanguageGuidance(input)}`,
    user: `${courseBlock(input)}

${analysisBlock(analysis)}

Plan:
${planBlock(plan)}`,
  };
}

export function outlinerPrompt(
  input: StudioInput,
  context: StudioContext,
  plan: StudioPlan,
  template: SlideTemplate,
  revision: { previous: StudioOutlineItem[]; feedback: string } | null,
  profile: DisciplineProfile = disciplineProfile(null),
): PromptPair {
  return {
    system: `${TEAM}
You are the OUTLINER agent. Turn the approved plan into a slide-by-slide outline of EXACTLY ${input.slideCount} slides.

Output NDJSON: one JSON object per line (one per slide, in order), no prose, no code fences:
{"section": string /* section id */, "type": string, "layout": string, "title": string /* final slide headline, 5-10 words */,
 "intent": string /* what the student learns on this slide, 1 sentence */, "cloCode": string|null,
 "visual": string /* "figure:<figure key>" | "mermaid:<diagram description>" | "none" */}

Types: ${SLIDE_TYPES}
Layouts: ${SLIDE_LAYOUTS}
Rules:
- Respect each section's slide count, order and phase.
- Map phases to types: title→TITLE/TITLE_CENTER; clo_scope→LEARNING_OUTCOMES/BULLETS (exact CLO wording +
  covered/partial/not_covered lists); roadmap→AGENDA/BULLETS (chapter-grounded teaching order); introduction→
  INTRODUCTION/BULLETS (motivating question + why it matters + CLO link; visual none); body→ teaching types;
  summary→SUMMARY/BULLETS titled "Key takeaways" with sectionLabel "Lecture summary" (visual none);
  knowledge_check→CHECKPOINT/BULLETS titled "Check your understanding" with sectionLabel "Knowledge check" and
  3–5 numbered question bullets (answers only in speakerNotes); references→REFERENCES (always last).
- Closing triad is mandatory and in this order: SUMMARY → Knowledge check → REFERENCES (never omit).
- Inside each body section: concept → worked example or visual → application. Do not teach not_covered CLO parts.
  Mid-deck ACTIVITY is fine; the final Knowledge check is the closing assessment slide.
- Titles are assertion headlines (see the standard below); no two slides share a title; intent is a measurable
  student takeaway. Prefer a short section/page cue in the intent when the excerpts provide one (never invent pages).
- Use COMPARISON for contrasts, FORMULA for equations, CODE (layout BULLETS, visual none) for source, DEFINITION
  for formal terms. Planned "code:", "formula:", "example:", "table:" become CODE, FORMULA, EXAMPLE, COMPARISON.
- ${templateBlock(template)}
- Prefer planned textbook figures before mermaid; a figure key appears at most once; never label AI diagrams as
  textbook figures. Mermaid ideas: one process/structure/contrast with at most 6 boxes.
- Show, don't only tell on body slides: at least half carry a figure, diagram, example, table or comparison.
- Prefer depth over coverage: keep highest-CLO points; drop survey slides.
- Vary layouts; no more than 2 plain BULLETS slides in a row among body content.
${disciplineBlock(profile)}

${PROFESSIONAL_STYLE}
${studioLanguageGuidance(input)}`,
    user: `${courseBlock(input)}

Approved plan:
${planBlock(plan)}

Reference figures:
${figuresBlock(context.figures)}
${
  revision
    ? `
PREVIOUS OUTLINE:
${revision.previous.map((item) => `${item.index + 1}. [${item.sectionId}] ${item.type}/${item.layout} ${item.title} — visual: ${visualToken(item)}`).join('\n')}

INSTRUCTOR FEEDBACK — revise the outline accordingly:
${revision.feedback}`
    : ''
}`,
  };
}

export function visualToken(item: Pick<StudioOutlineItem, 'visual'>) {
  if (item.visual.kind === 'figure') return `figure:${item.visual.figureKey}`;
  if (item.visual.kind === 'mermaid') return `mermaid:${item.visual.idea}`;
  return 'none';
}

const SLIDE_SCHEMA = `{"n": integer /* the slide number given */, "type", "layout", "title", "subtitle"?, "sectionLabel"?,
 "bullets"?: string[], "leftColumn"?: {"heading", "bullets"}, "rightColumn"?: {"heading", "bullets"},
 "callout"?: {"label", "text"}, "formula"?: {"latex", "explanation"},
 "code"?: {"language", "source" /* lines joined with \\n, indentation kept */, "highlight"?: integer[] /* 1-based lines */, "output"?, "caption"?},
 "example"?: {"problem", "steps": string[], "solution"},
 "table"?: {"headers": string[], "rows": string[][]}, "diagram"?: {"title", "mermaid"},
 "cloCode"?: string, "bloomLevel": "Remember"|"Understand"|"Apply"|"Analyze"|"Evaluate"|"Create",
 "teachingBeat"?: "explain"|"example"|"check"|"frame",
 "speakerNotes": string}`;

const SLIDE_BODY_RULES = `Body rules (the slide is 16:9 — everything must fit without scrolling):
- TITLE / SECTION slides: title + subtitle only.
- CONTENT, AGENDA, LEARNING_OUTCOMES, SUMMARY → 3-5 bullets designed as graphic cards: "**Term** — one claim"
  (8-16 words after the dash), parallel grammar, each carrying a teachable claim (mechanism, condition, result or
  decision). No filler, no "In this slide…", no topic-name bullets. Bold the one key term with **term** (at most one bold run per bullet).
  Prefer 3-card rows for mechanisms, 2-column COMPARISON for contrasts, EXAMPLE_STEPS for worked problems.
- LEARNING_OUTCOMES (clo_scope) → sectionLabel "Course learning outcome & lecture scope"; title "What this lecture
  covers from {CLO code}". callout = the original CLO statement unchanged. table = two columns
  ("In this lecture" | "CLO components") with up to three rows: Covered / Partially covered / Not covered.
  Separate components in a cell with "; ". Never imply the whole CLO is achieved here if the map says otherwise. No visual.
- AGENDA (roadmap) → sectionLabel "Lecture roadmap"; title "Today's path through {chapter}". Numbered stops:
  "n. **Title** — one-line outcome". Add a chapter/section cue only when the excerpts name it. Never invent § or page numbers. No visual.
- INTRODUCTION → sectionLabel "Introduction"; title is a concrete hook (never the word "Introduction");
  callout {label: "Think about it", text: a short scenario ending with one question}; 3 bullets exactly:
  "**Context** — …", "**Why it matters** — …", "**Link to CLO** — …". Frames only — no teaching the first concept.
- SUMMARY → sectionLabel "Lecture summary"; title "Key takeaways"; 4–6 takeaway cards as "**Term** — one claim"
  for content actually taught; callout {label: "Contribution to CLO", text: covered parts only}. No visual. Do not claim full CLO
  mastery. Prefer SUMMARY over CONCLUSION for the closing recap.
- CONCLUSION (legacy) → rewrite as SUMMARY ("Key takeaways" / sectionLabel "Lecture summary") when used as the closing recap.
- CHECKPOINT (closing knowledge_check) → sectionLabel "Knowledge check"; title "Check your understanding"; layout BULLETS
  with 3–5 numbered questions (1. … 2. …) assessing only taught content; speakerNotes starts with "Answer:" per
  question. Do not assess not_covered CLO parts. (Single-prompt ACTIVITY mid-deck may still use QUOTE_CALLOUT.)
- DEFINITION → callout {label, text ≤ 35 words, the precise formal definition} + up to 2 bullets (necessary condition,
  non-example or boundary case). Avoid dictionary-style paraphrases that drop technical constraints.
- FORMULA → formula {latex: valid KaTeX without $ delimiters (escape backslashes as \\\\ in JSON), explanation that names
  every symbol and the assumption it needs} + up to 2 bullets on when to use it / when it fails.
- CODE → code {language (python, java, cpp, c, javascript, sql, shell…), source: ≤ 12 lines of real, runnable code,
  ≤ 60 characters per line, highlight: 1-3 line numbers the bullets discuss, output: what it prints when run (≤ 3 lines,
  omit when nothing is printed), caption: file name or short label} + 1-3 short bullets explaining the highlighted
  lines. Elide irrelevant lines with "…" instead of shrinking the font. Never put code in bullets, never pair code
  with a diagram.
- EXAMPLE → example {problem with concrete values/data, steps (2-4, each ≤ 20 words, each naming the rule used),
  solution with numeric/symbolic result + one-line interpretation}.
- COMPARISON → two items: leftColumn + rightColumn with matching aspects in the same order (3-4 bullets each), no table.
  Three or more items, or several attributes: type CONTENT, layout BULLETS, table {headers: 2-4 short, rows: 2-5,
  cells ≤ 6 words} with at most 2 bullets, no columns. Never both columns and a table.
- ACTIVITY (mid-deck) → callout {label: "Activity", text: one short task}; speakerNotes = expected outcome.
- Closing CHECKPOINT → prefer bullets (numbered questions), not a single callout blob.
- Visual "mermaid:<idea>" → diagram {title, mermaid} AND 1-3 short bullets. Mermaid: flowchart LR for a sequence of
  ≤ 5 steps, flowchart TD for a hierarchy (or sequenceDiagram / stateDiagram-v2 / classDiagram when clearly better);
  3-6 nodes and at most 4 levels so labels stay readable when projected; labels ≤ 4 words in double quotes, \\n for a
  line break, no HTML, no styling.
- REFERENCES → bullets: [] (the cited sources are inserted automatically from the course references).
- A layout engine measures every slide on the real 16:9 stage; text that does not fit is cut off. Beside a figure or
  diagram the text column is under half the width, so keep those bullets especially short (6-12 words) and specific.
- Visual "figure:<key>" → the textbook figure is attached automatically unchanged; write 1-3 bullets on what to notice
  and how it supports the headline; mention figure caption/page in speakerNotes when known. Do not include a diagram
  and never redraw or claim an AI diagram is the textbook figure.
- Visual "mermaid:<idea>" → original educational diagram (AI-generated); speakerNotes may note "AI-generated educational illustration".
- type and layout must be the matching pair, and the body must fill that layout's main element:
  CONTENT|DIAGRAM|CODE|AGENDA|LEARNING_OUTCOMES|SUMMARY|INTRODUCTION|CONCLUSION|CHECKPOINT → BULLETS,
  DEFINITION → DEFINITION, FORMULA → FORMULA_FOCUS, EXAMPLE → EXAMPLE_STEPS,
  COMPARISON → TWO_COLUMN (needs both columns), ACTIVITY → QUOTE_CALLOUT. Never use TWO_COLUMN without columns
  or EXAMPLE_STEPS without a real worked example — such text is hidden on the slide.
- Every content slide shows readable text: a figure or diagram is never the whole slide.
- Say each thing once: never repeat the bullets inside the example/callout (or the other way round), and do not reuse
  sentences from other slides. No markdown other than **bold**.
- speakerNotes: follow Instructor preferences. If speaker notes are required, write a teaching script the
  instructor can read, 4-6 sentences, first person to the class: start with "CLO component: <label>." then what
  to say (analogy or real case), a misconception or cold-call question, the figure source when the slide has a
  visual ("textbook figure p. N" or "AI-generated educational illustration"), and a one-sentence transition.
  Never read the bullets back. If preferences say omit speaker notes, set speakerNotes to "".
- Body slides that teach a partial CLO component: set sectionLabel to "Partially covered — continued later"
  (Arabic: "تغطية جزئية — يُستكمل لاحقاً"). Do not imply that component is finished.
- One idea per slide. Prefer graphic components over a wall of bullets: 2–3 icon cards ("**Term** — claim"),
  two-column comparison cards, a navy banner plus coverage cards (CLO), a Think-about-it panel, a numbered roadmap,
  a worked example with a Result card, a textbook figure, or a mermaid diagram. Optional § / page cues in
  sectionLabel only when the excerpts name them; never invent.
- Stay faithful to the reference excerpts and their terminology; never invent facts, numbers, citations or pages.`;

function slideLine(item: StudioOutlineItem, figureByKey: Map<string, StudioFigure>) {
  const figure = item.visual.kind === 'figure' ? figureByKey.get(item.visual.figureKey) : null;
  return `n=${item.index + 1} | ${item.type}/${item.layout} | "${item.title}" | intent: ${item.intent} | CLO: ${item.cloCode ?? '-'} | visual: ${
    figure ? `figure "${figure.caption}"` : visualToken(item)
  }`;
}

function deckFlowBlock(outline: StudioOutlineItem[], highlight: Set<number>) {
  return outline
    .map(
      (item) =>
        `${highlight.has(item.index) ? '→' : ' '} ${item.index + 1}. [${item.type}] ${item.title}`,
    )
    .join('\n');
}

export function writerPrompt(
  input: StudioInput,
  analysis: StudioAnalysis | null,
  plan: StudioPlan,
  section: StudioPlanSection,
  items: StudioOutlineItem[],
  outline: StudioOutlineItem[],
  excerpts: StudioExcerpt[],
  figures: StudioFigure[],
  template: SlideTemplate,
): PromptPair {
  const figureByKey = new Map(figures.map((figure) => [figure.key, figure]));
  const profile = disciplineProfile(analysis?.profile);
  return {
    system: `${TEAM}
You are the WRITER agent. Write the final content of the slides you are given, one JSON object per line (NDJSON),
in order, no prose, no code fences, no array brackets.

Slide object fields: ${SLIDE_SCHEMA}

${SLIDE_BODY_RULES}
- Other writers handle the other sections in parallel: do not re-explain ideas that belong to other slides of the deck flow.
- Teach only what the section CLOs require. Use excerpts solely for CLO-related concepts, terms and examples —
  skip neighbouring chapter material that the CLO descriptions do not call for.
- Write lecture-ready slides a senior professor would project tomorrow: precise, evidence-backed and visually clean.
- ${templateBlock(template)}

${disciplineBlock(profile)}

${PROFESSIONAL_STYLE}

${CONTENT_DEPTH}

${exemplars(profile)}
${studioLanguageGuidance(input)}`,
    user: `${courseBlock(input)}

${analysisBlock(analysis)}
Deck: ${plan.title}. Approach: ${plan.approach}

Deck flow (→ marks your slides):
${deckFlowBlock(outline, new Set(items.map((item) => item.index)))}

Section "${section.title}" — goal: ${section.goal}; CLOs: ${section.cloCodes.join(', ') || '-'}; key points: ${section.keyPoints.join(' / ')}

Slides to write (keep each title's claim; prove it in the body):
${items.map((item) => slideLine(item, figureByKey)).join('\n')}

Reference excerpts for this section (CLO-scoped):
${excerptsBlock(excerpts, 12_000)}`,
  };
}

/** What the rendered slide looks like, as measured by the layout estimator. */
function fitLine(slide: StudioSlide) {
  const fit = estimateSlideFit(slide);
  if (!fit || fit.arrangement === 'fill') return null;
  const where = fit.arrangement === 'side' ? 'beside the visual' : fit.arrangement === 'stack' ? 'above the visual' : 'full width';
  const state = fit.fill > 1 ? 'OVERFLOWS' : fit.fill > 0.92 ? 'crammed' : fit.fill < 0.18 ? 'sparse' : 'fits';
  const diagram =
    fit.diagramLabelPx != null ? `; diagram labels ≈${fit.diagramLabelPx}px${fit.diagramLabelPx < 10 ? ' (unreadable)' : ''}` : '';
  return `rendered: text uses ${Math.round(fit.fill * 100)}% of its area ${where} (${state})${diagram}`;
}

function slideDigest(slide: StudioSlide, index: number) {
  const image = (slide as { image?: { caption?: string } }).image;
  const parts = [
    slide.subtitle ? `subtitle: ${slide.subtitle}` : null,
    slide.bullets?.length ? `bullets: ${slide.bullets.map((bullet) => `• ${bullet}`).join(' ')}` : null,
    slide.leftColumn
      ? `left "${slide.leftColumn.heading ?? ''}": ${(slide.leftColumn.bullets ?? []).join(' • ')}`
      : null,
    slide.rightColumn
      ? `right "${slide.rightColumn.heading ?? ''}": ${(slide.rightColumn.bullets ?? []).join(' • ')}`
      : null,
    slide.callout?.text ? `callout ${slide.callout.label ?? ''}: ${slide.callout.text}` : null,
    slide.formula?.latex ? `formula: ${slide.formula.latex} — ${slide.formula.explanation ?? ''}` : null,
    slide.code?.source
      ? `code (${slide.code.language || '?'}, ${slide.code.source.split('\n').length} lines${
          slide.code.highlight?.length ? `, highlight ${slide.code.highlight.join(',')}` : ''
        }):\n${slide.code.source
          .split('\n')
          .slice(0, 14)
          .map((line, row) => `      ${row + 1}| ${line}`)
          .join('\n')}${slide.code.output ? `\n      output: ${slide.code.output}` : ''}`
      : null,
    slide.example
      ? `example: ${slide.example.problem ?? ''} | steps: ${(slide.example.steps ?? []).join(' / ')} | solution: ${slide.example.solution ?? ''}`
      : null,
    slide.table?.headers?.length
      ? `table: ${slide.table.headers.join(' | ')} (${slide.table.rows?.length ?? 0} rows)`
      : null,
    slide.diagram?.mermaid ? `diagram: ${slide.diagram.title ?? ''}` : null,
    image?.caption ? `figure: ${image.caption}` : null,
    fitLine(slide),
    slide.speakerNotes ? `notes: ${String(slide.speakerNotes).slice(0, 240)}` : null,
  ].filter(Boolean);
  return `${index + 1}. [${slide.type}/${slide.layout}] "${slide.title}" (CLO ${slide.cloCode ?? '-'}, ${slide.bloomLevel ?? '-'})\n   ${parts.join('\n   ')}`;
}

export function inspectorPrompt(
  input: StudioInput,
  plan: StudioPlan,
  slides: StudioSlide[],
  excerpts: StudioExcerpt[],
  automated: StudioQaFinding[],
  profile: DisciplineProfile = disciplineProfile(null),
): PromptPair {
  return {
    system: `${TEAM}
You are the INSPECTOR agent (quality control). Audit every slide of the draft deck like a strict senior instructor:
- accuracy: contradicts or goes beyond the reference excerpts, wrong formula, wrong example arithmetic;
- clarity: vague title, filler, jargon not defined, bullets that are not parallel or not self-contained;
- pedagogy: slide does not serve its CLO, missing example after a hard concept, checkpoint without a real question,
  shallow survey bullets that name topics without teaching a mechanism/condition/result;
- layout: body too dense for a 16:9 slide, wrong element for the content (e.g. comparison written as plain bullets),
  a figure/diagram with no text telling students what to notice, a diagram that does not match its bullets or title,
  type/layout that does not fit the body (TWO_COLUMN shows only the columns, EXAMPLE_STEPS the worked example);
- coherence: repeats another slide, the same text twice on one slide (bullets copied into the example or callout,
  a table that restates the columns), breaks the teaching order, inconsistent terminology;
- framing: LEARNING_OUTCOMES must keep the original CLO and show covered / partial / not_covered honestly;
  INTRODUCTION must motivate (Think about it) and preview, not teach the first concept;
  the deck must close Lecture summary → Knowledge check ("Check your understanding") → References;
  a SUMMARY that claims the whole CLO while the map has partial/not_covered is a pedagogy finding;
  an AI diagram labeled as a textbook figure is a high accuracy finding;
- polish: headline is a topic label instead of a claim, the body does not prove the headline, mixed fragment and
  sentence bullets, hype or filler, hedging or meta-commentary ("not a complete list", "varies by system"), vague
  quantities where the reference gives numbers, speaker notes that only read the bullets back, off-CLO padding
  from neighbouring chapter material.
Ask of every slide: "Would a senior professor project this as-is tomorrow?" If not, say exactly what to change.
Flag shallow content as medium pedagogy: a bullet that only names a topic, a definition that drops constraints,
or an Apply CLO taught only as prose when an EXAMPLE/FORMULA/CODE would fit.
Fact audit (do it before anything else): recompute every worked example, formula and number; check each definition,
value, date and name against the reference excerpts. A wrong fact or result is always "high" and its message states
the correct value. Claims the excerpts do not support are "medium" accuracy findings.
${disciplineAudit(profile)} A core slide that explains in prose what the field normally shows (code, a formula,
a figure, a worked case) is a "medium" pedagogy finding naming the element to add.
Each slide's "rendered:" line is measured on the real 16:9 stage (overflow, crowding, diagram label size). Automated
checks already found the issues listed in the user message (and fixed the purely structural ones); do not repeat them.
Severity: high = wrong or misleading, the slide cannot be shown; medium = a professor would edit it before class;
low = optional polish.
Return ONLY one JSON object:
{"score": integer /* 0-100 quality of the draft */,
 "findings": [{"slide": integer, "severity": "low"|"medium"|"high", "category": "accuracy"|"clarity"|"pedagogy"|"layout"|"coherence"|"polish",
   "message": string /* concrete fix instruction for the optimizer, ≤ 30 words: what to change and to what */}]
   /* at most 16, most important first */}
${studioLanguageGuidance(input)}`,
    user: `${courseBlock(input)}

Plan: ${plan.title} — ${plan.approach}

Draft deck:
${slides.map(slideDigest).join('\n')}

Automated findings:
${automated.length ? automated.map((finding) => `- slide ${finding.slide} [${finding.severity}] ${finding.message}`).join('\n') : '- none'}

Reference excerpts:
${excerptsBlock(excerpts, 24_000)}`,
  };
}

/** Focused re-check of rewritten slides: were the reported problems really fixed, and did the rewrite break anything? */
export function verifierPrompt(
  input: StudioInput,
  slides: StudioSlide[],
  rechecks: Array<{ index: number; problems: string[] }>,
  excerpts: StudioExcerpt[],
  profile: DisciplineProfile = disciplineProfile(null),
): PromptPair {
  return {
    system: `${TEAM}
You are the INSPECTOR agent verifying slides the optimizer just rewrote. For each slide, decide for every listed
problem whether the rewrite fully fixed it, then check that the rewrite did not introduce new problems: a wrong fact
or calculation, a claim the excerpts do not support, lost key content, a headline the body no longer proves, text
that no longer fits ("rendered:" line), or a break in the flow with the neighbouring slides.
${disciplineAudit(profile)}
Report ONLY problems that remain or are new; return an empty list when a slide is now ready to project.
Return ONLY one JSON object:
{"findings": [{"slide": integer, "severity": "low"|"medium"|"high", "category": "accuracy"|"clarity"|"pedagogy"|"layout"|"coherence"|"polish",
   "message": string /* concrete fix instruction, ≤ 30 words */}]}
${studioLanguageGuidance(input)}`,
    user: `${courseBlock(input)}

Deck flow:
${slides.map((slide, index) => `${index + 1}. [${slide.type}] ${slide.title}`).join('\n')}

Rewritten slides:
${rechecks
  .map(
    ({ index, problems }) =>
      `${slideDigest(slides[index], index)}\n   WAS ASKED TO FIX: ${problems.join(' | ') || '-'}`,
  )
  .join('\n\n')}

Reference excerpts:
${excerptsBlock(excerpts, 16_000)}`,
  };
}

export function optimizerPrompt(
  input: StudioInput,
  plan: StudioPlan,
  template: SlideTemplate,
  slides: StudioSlide[],
  outline: StudioOutlineItem[],
  targets: Array<{ index: number; problems: string[] }>,
  excerpts: StudioExcerpt[],
  figures: StudioFigure[],
  profile: DisciplineProfile = disciplineProfile(null),
): PromptPair {
  const figureByKey = new Map(figures.map((figure) => [figure.key, figure]));
  return {
    system: `${TEAM}
You are the OPTIMIZER agent. Rewrite ONLY the listed slides so that every reported problem is fixed, keeping each
slide's purpose, CLO and visual. Output NDJSON: one complete slide object per line, no prose, no code fences.

Slide object fields: ${SLIDE_SCHEMA}

${SLIDE_BODY_RULES}
- Keep the existing diagram (copy it unchanged) unless a problem concerns it; a figure stays attached automatically.
- A slide with a figure or diagram still needs 1-3 bullets that explain it; do not drop text to make room for it.
- Return the whole slide (all fields, including speakerNotes), not only the changed parts.
- When a slide OVERFLOWS, cut words until it fits: merge or drop the weakest bullet and move detail into speakerNotes
  rather than shrinking every bullet slightly.
- Fix accuracy problems first, using the excerpts' exact values and terms; never trade correctness for brevity.
- When fixing shallow content, replace topic-name bullets with mechanism/condition/result claims; do not merely
  rephrase fluff.
- A problem starting with "REJECTED REWRITE" lists what your previous rewrite of that slide broke; avoid it this time.
- Do not create new problems: keep every correct key point, keep the headline proven by the body and keep the slide
  within its rendered area.
- When a problem asks for the field's evidence (code, formula, worked example, table…), change the slide's type and
  layout to match the element you add (CODE → BULLETS, FORMULA → FORMULA_FOCUS, EXAMPLE → EXAMPLE_STEPS).
- ${templateBlock(template)}

${disciplineBlock(profile)}

${PROFESSIONAL_STYLE}

${CONTENT_DEPTH}

${exemplars(profile)}
${studioLanguageGuidance(input)}`,
    user: `${courseBlock(input)}

Deck: ${plan.title}
Deck flow (→ marks slides to rewrite):
${deckFlowBlock(outline, new Set(targets.map((target) => target.index)))}

Slides to rewrite:
${targets
  .map((target) => {
    const slide = slides[target.index];
    const item = outline[target.index];
    return `${slideDigest(slide, target.index)}${slide.diagram?.mermaid ? `\n   current mermaid:\n${slide.diagram.mermaid}` : ''}
   planned: ${item ? slideLine(item, figureByKey) : '-'}
   PROBLEMS: ${target.problems.join(' | ')}`;
  })
  .join('\n\n')}

Reference excerpts:
${excerptsBlock(excerpts, 20_000)}`,
  };
}

/**
 * Instructor-triggered rewrite of a single slide. Same schema as the writer /
 * optimizer, but scoped to one index and optional free-text feedback.
 */
export function regenerateSlidePrompt(
  input: StudioInput,
  plan: StudioPlan,
  template: SlideTemplate,
  slides: StudioSlide[],
  outline: StudioOutlineItem[],
  index: number,
  feedback: string | null,
  excerpts: StudioExcerpt[],
  figures: StudioFigure[],
  profile: DisciplineProfile = disciplineProfile(null),
): PromptPair {
  const figureByKey = new Map(figures.map((figure) => [figure.key, figure]));
  const slide = slides[index];
  const item = outline[index];
  const neighbors = slides
    .map((entry, i) =>
      Math.abs(i - index) === 1
        ? `${i + 1}. [${entry.type}] "${entry.title}"`
        : null,
    )
    .filter(Boolean)
    .join('\n');
  const frameTypes = new Set([
    'TITLE',
    'LEARNING_OUTCOMES',
    'AGENDA',
    'INTRODUCTION',
    'SUMMARY',
    'CHECKPOINT',
    'REFERENCES',
  ]);
  const lockedType = frameTypes.has(String(slide?.type || '').toUpperCase());
  return {
    system: `${TEAM}
You are rewriting ONE lecture slide for an instructor. Keep the slide's teaching purpose, CLO and visual intent.
Return ONLY one JSON slide object (no markdown fences, no commentary).

Slide object fields: ${SLIDE_SCHEMA}

${SLIDE_BODY_RULES}
- Keep n=${index + 1}.
${lockedType ? `- Keep type "${slide?.type}" and layout "${slide?.layout}" (frame slide).` : '- You may change type/layout only when the instructor feedback requires a different teaching form (e.g. add a worked example).'}
- Keep the existing diagram unchanged unless feedback asks to redesign it; a textbook figure stays attached automatically.
- Do not repeat neighbouring slides.
- If feedback is provided, satisfy it while staying faithful to the excerpts.
- ${templateBlock(template)}

${disciplineBlock(profile)}

${PROFESSIONAL_STYLE}

${CONTENT_DEPTH}

${exemplars(profile)}
${studioLanguageGuidance(input)}`,
    user: `${courseBlock(input)}

Deck: ${plan.title}
Neighboring slides:
${neighbors || '- (none)'}

Current slide:
${slideDigest(slide, index)}${slide?.diagram?.mermaid ? `\n   current mermaid:\n${slide.diagram.mermaid}` : ''}
Planned: ${item ? slideLine(item, figureByKey) : '-'}

Instructor feedback: ${feedback?.trim() || '(none — improve clarity, depth and classroom usefulness while keeping the same purpose)'}

Reference excerpts:
${excerptsBlock(excerpts, 16_000)}`,
  };
}

export function illustratorPrompt(
  input: StudioInput,
  jobs: Array<{
    n: number;
    title: string;
    idea: string;
    current: string | null;
    problems: string[];
    cloCode?: string | null;
  }>,
  excerpts: StudioExcerpt[] = [],
): PromptPair {
  const linked = input.clos.filter((clo) => clo.linked);
  const clos = (linked.length ? linked : input.clos)
    .map((clo) => `- ${clo.code}: ${clo.description}`)
    .join('\n');
  return {
    system: `${TEAM}
You are the ILLUSTRATOR agent. You write Mermaid diagrams that render with mermaid v11.
Output NDJSON, one line per requested slide: {"n": integer, "title": string, "mermaid": string}. No prose, no code fences.
Rules: start with "flowchart LR" (sequences of ≤ 5 steps), "flowchart TD" (hierarchies), "sequenceDiagram",
"stateDiagram-v2", "classDiagram" or "timeline" (dated events: "timeline\\n    1932 : Event"); 3-6 nodes and at most 4 levels, because the diagram shares a 16:9 slide with text and
must stay readable from the back of a lecture hall; labels ≤ 4 words in double quotes; no HTML, no classDef/style
lines; use \\n inside JSON strings for line breaks.
Ground each diagram in the slide's CLO and the related reference excerpts — do not invent off-topic nodes from
unrelated chapter material. Prefer the field's standard names/symbols on nodes; keep one clear teaching story
(input → transform → result, or hierarchy of concepts) that a student can retell after class.
${studioLanguageGuidance(input)}`,
    user: `Topic: ${input.topicTitle} (${input.courseTitle})

Topic CLOs:
${clos || '- (none)'}

Reference excerpts (CLO-related only):
${excerptsBlock(excerpts, 6_000)}

Diagrams to ${jobs.some((job) => job.current) ? 'create or fix' : 'create'}:
${jobs
  .map(
    (job) =>
      `n=${job.n} | slide "${job.title}" | CLO: ${job.cloCode || '-'} | idea: ${job.idea}${
        job.current
          ? `\nCurrent (broken: ${job.problems.join('; ')}):\n${job.current}`
          : ''
      }`,
  )
  .join('\n\n')}`,
  };
}

export function reviewerPrompt(
  input: StudioInput,
  plan: StudioPlan,
  slides: StudioSlide[],
  excerpts: StudioExcerpt[],
  profile: DisciplineProfile = disciplineProfile(null),
): PromptPair {
  const deck = slides.map(slideDigest).join('\n');
  return {
    system: `${TEAM}
You are the REVIEWER agent (quality assurance). Check the deck against the plan, CLO component map and excerpts:
coverage honesty, accuracy, clarity, progression, visual provenance and professional polish.
Required arc: TITLE, LEARNING_OUTCOMES (CLO scope with covered/partial/not_covered bands), AGENDA, INTRODUCTION
(Think about it), body teaching, Lecture summary (Key takeaways), Knowledge check (Check your understanding),
References (always last, with figure provenance).
Score as a demanding department head: 90+ only if projectable tomorrow; below 80 if survey-like, off-CLO,
missing Summary or Check your understanding, claims full CLO when map has gaps, or AI diagrams are presented as textbook figures.
${disciplineAudit(profile)}
Slide-specific medium/high issues go to the optimizer — write concrete fix instructions with slide numbers.
Return ONLY one JSON object:
{"score": integer /* 0-100 */, "summary": string /* 2 sentences for the instructor */,
 "cloCoverage": [{"code": string, "slides": integer[]}],
 "cloComponentCoverage": [{"id": string, "cloCode": string, "label": string,
   "status": "covered"|"partial"|"not_covered", "slides": integer[], "note": string}],
 "visualSources": [{"slide": integer, "classification": "textbook"|"ai_generated"|"none"|"not_verified",
   "description": string, "figureKey"?: string, "pageNumber"?: integer}],
 "issues": [{"slide": integer|null, "severity": "low"|"medium"|"high", "message": string}] /* at most 8 */}
${studioLanguageGuidance(input)}`,
    user: `${courseBlock(input)}

Plan:
${planBlock(plan)}

Deck:
${deck}

Reference excerpts:
${excerptsBlock(excerpts, 12_000)}`,
  };
}
