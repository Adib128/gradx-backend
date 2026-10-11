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
  ("Pipes connect one program's output to the next"), never a topic label ("Pipes", "Overview", "Introduction").
- The body is the evidence for that claim: a figure, diagram, worked example, table or tight bullets — show, then tell.
- One idea per slide. If the idea needs more than ~60 words of on-slide text, it belongs on two slides.
- Bullets: parallel grammar, start with the key noun or verb, one **key term** in bold at most, either all fragments
  (no periods) or all full sentences on a slide. No filler ("It is important to note", "In this slide").
- Precision: concrete values with units, named cases and the reference's own terminology; define a term the first
  time it appears; never vague quantifiers ("many", "various") when the reference gives a number.
- Academic tone: neutral and confident; no hype words, exclamation marks or emojis.
- Accessibility: meaning never depends on colour alone; diagram labels ≤ 4 words.`;

/** Style exemplars from another field, so they shape form without leaking content. */
const EXEMPLARS = `Style exemplars (different course — copy the form, never the content):
{"n":7,"type":"DIAGRAM","layout":"BULLETS","title":"Enzymes lower the activation barrier, not ΔG","bullets":["**Activation energy** drops, so more collisions react at 37 °C","ΔG and the equilibrium position stay unchanged","Catalase speeds H₂O₂ breakdown about 10⁷-fold"],"diagram":{"title":"Two paths from substrate to product","mermaid":"flowchart LR\\nS[\\"Substrate\\"] --> T[\\"Uncatalysed\\\\nhigh barrier\\"] --> P[\\"Product\\"]\\nS --> E[\\"Enzyme complex\\\\nlow barrier\\"] --> P"},"cloCode":"CLO 1.2","bloomLevel":"Understand","speakerNotes":"An enzyme does not change where a reaction ends up, only how fast it gets there. Compare the two paths: both start and finish at the same energy, so ΔG is identical, but the enzyme path crosses a much lower hill. Think of a mountain tunnel: the destination is the same, the climb is not. Next, we quantify this speed-up with the Michaelis–Menten model."}
{"n":12,"type":"EXAMPLE","layout":"EXAMPLE_STEPS","title":"A 10% price rise cuts demand by 15%","example":{"problem":"A café raises a latte from 20 to 22 SAR; daily sales fall from 400 to 340 cups. Is demand elastic?","steps":["%ΔQ = (340 − 400) / 400 = −15%","%ΔP = (22 − 20) / 20 = +10%","Ed = −15% / 10% = −1.5"],"solution":"|Ed| = 1.5 > 1, so demand is elastic: revenue falls from 8,000 to 7,480 SAR."},"cloCode":"CLO 2.1","bloomLevel":"Apply","speakerNotes":"Walk through the three steps on the board before revealing the result. Ask students to predict revenue first. Elastic demand means the percentage drop in quantity outweighs the price rise, so revenue falls. Next, we see which goods tend to be elastic and why."}`;

const CODE_EXEMPLAR = `{"n":9,"type":"CODE","layout":"BULLETS","title":"A dictionary counts words in one pass","bullets":["**get(w, 0)** returns 0 for a word not seen yet","Each word costs one O(1) lookup, so the loop is O(n)"],"code":{"language":"python","source":"text = \\"to be or not to be\\"\\ncounts = {}\\nfor w in text.split():\\n    counts[w] = counts.get(w, 0) + 1\\nprint(counts)","highlight":[4],"output":"{'to': 2, 'be': 2, 'or': 1, 'not': 1}","caption":"word_count.py"},"cloCode":"CLO 2.2","bloomLevel":"Apply","speakerNotes":"Read line 4 aloud: look the word up, default to zero, add one. Ask students what happens without the default. Next, we replace this loop with collections.Counter."}`;

function exemplars(profile: DisciplineProfile) {
  return profile.id === 'programming' || profile.id === 'computing' ? `${EXEMPLARS}\n${CODE_EXEMPLAR}` : EXEMPLARS;
}

const SLIDE_TYPES =
  'TITLE | AGENDA | LEARNING_OUTCOMES | SECTION | CONTENT | DEFINITION | FORMULA | CODE | DIAGRAM | EXAMPLE | COMPARISON | ACTIVITY | CHECKPOINT | SUMMARY | REFERENCES';
const SLIDE_LAYOUTS =
  'TITLE_CENTER | BULLETS | TWO_COLUMN | DEFINITION | FORMULA_FOCUS | EXAMPLE_STEPS | QUOTE_CALLOUT | SECTION_DIVIDER';

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
Visual strategy: ${analysis.visualStrategy}`;
}

function planBlock(plan: StudioPlan) {
  return `Deck title: ${plan.title}
Approach: ${plan.approach}
Learning goals: ${plan.learningGoals.join(' | ')}
Sections:
${plan.sections
  .map(
    (section, index) =>
      `${index + 1}. [${section.id}] ${section.title} — ${section.slideCount} slide(s); goal: ${section.goal}; CLOs: ${section.cloCodes.join(', ') || '-'}; key points: ${section.keyPoints.join(' / ')}; visuals: ${section.visuals.join(', ') || 'none'}`,
  )
  .join('\n')}`;
}

function templateBlock(template: SlideTemplate) {
  return `Template "${template.name.en}": density ${template.style.density}; tone: ${template.style.tone}; preferred layouts: ${template.style.preferredLayouts.join(', ')}; visuals: ${template.style.visualEmphasis}.`;
}

export function analystPrompt(input: StudioInput, context: StudioContext): PromptPair {
  return {
    system: `${TEAM}
You are the ANALYST agent. Classify the teaching material so the other agents can adapt pedagogy and visuals.
Return ONLY one JSON object:
{"profile": ${Object.keys(DISCIPLINES).map((id) => `"${id}"`).join('|')} /* teaching profile, see below */,
 "field": string, "discipline": string, "subfield": string,
 "materialTypes": string[] /* from: theoretical, mathematical, procedural, programming, experimental, case-based, descriptive, clinical */,
 "audienceLevel": string, "keyConcepts": string[] /* 5-10 */,
 "visualStrategy": string /* which visuals teach this best: textbook figures, process/sequence/state diagrams, formulas, tables */,
 "summary": string /* 2 sentences describing what this topic covers */}
Profiles (pick the one whose teaching evidence fits the material, not only the department name):
${Object.values(DISCIPLINES)
  .map((profile) => `- ${profile.id}: ${profile.label} — taught with ${profile.evidence}`)
  .join('\n')}
Choose programming when students write or read source code; computing for systems/theory courses (networks, OS,
databases, AI) where code is occasional; mathematics when results are derived and computed; general only when none fits.
${contentLanguageGuidance(input.language)}`,
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
Line 1: {"type":"meta","title":string,"approach":string /* pedagogy in 1-2 sentences */,"learningGoals":string[] /* 3-5, measurable, Bloom verbs */}
Then one line per section, in teaching order:
{"type":"section","title":string,"goal":string,"cloCodes":string[],"slideCount":integer,"keyPoints":string[] /* 2-5 */,"visuals":string[]}

Rules:
- The sum of slideCount over all sections MUST equal ${input.slideCount}.
- First section opens the lecture (title slide + outcomes/agenda); last section closes it (summary + checkpoint question).
- Usually 4-8 sections; every core section maps to at least one CLO code from the list.
- Ground key points in the reference excerpts; use their terminology and examples.
- Think like an expert professor: sequence from prerequisites to the hardest idea, and where students commonly
  hold a misconception about a key point, make correcting it one of that section's key points.
- When reference excerpts are provided, the closing section also contains one REFERENCES slide (its list of sources
  is filled automatically) — count it in that section's slideCount.
- visuals entries are "figure:<figure key>" (ONLY keys from the figure list, pick the most instructive ones) or "mermaid:<short description of a diagram to draw>".
- Prefer reference figures when one directly shows the concept; use mermaid for processes, flows, hierarchies, states and comparisons.
- Plan the field's own evidence too: "code:<what the snippet shows>", "formula:<equation>", "example:<worked case>" or
  "table:<what it compares>" entries in visuals.
${disciplineBlock(disciplineProfile(analysis?.profile))}
${contentLanguageGuidance(input.language)}`,
    user: `${courseBlock(input)}

${analysisBlock(analysis)}

Reference excerpts:
${excerptsBlock(context.excerpts, 40_000)}

Reference figures (key: caption):
${figuresBlock(context.figures)}
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
Templates:
${templateCatalogForPrompt(input.customTemplates)}

Return ONLY one JSON object:
{"templateId": string, "rationale": string /* 1-2 sentences addressed to the instructor */,
 "alternatives": [{"templateId": string, "reason": string}] /* exactly 2 other good options */}
${contentLanguageGuidance(input.language)}`,
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
- Respect each section's slide count and order. Slide 1 is TITLE/TITLE_CENTER.
- Teaching arc: open with a motivating question or real-world problem, then the learning outcomes; inside each
  core section go concept → worked example or visual → application; close with SUMMARY and a CHECKPOINT.
- Insert a CHECKPOINT or ACTIVITY roughly every 6-8 slides; every key concept is followed within 2 slides by an
  EXAMPLE, a visual or a COMPARISON.
- Titles are assertion headlines (see the standard below); no two slides share a title.
- Use COMPARISON for contrasts, FORMULA for equations the students must use, CODE (layout BULLETS, visual none) for
  source code, commands or queries the students must read or write, DEFINITION for formal terms.
- Planned "code:", "formula:", "example:" and "table:" visuals become CODE, FORMULA, EXAMPLE and COMPARISON slides.
- ${templateBlock(template)}
- Use the planned visuals; a figure key may appear at most once; only keys from the list. Never repeat a diagram idea.
- Show, don't only tell: at least half of the core content slides carry a figure, a diagram, a worked example, a
  table or a comparison. A diagram idea is one process, structure or contrast with at most 6 boxes.
- Vary layouts; no more than 2 plain BULLETS slides in a row.
- If the plan has a REFERENCES slide, it is the last slide: type REFERENCES, layout BULLETS, visual none.
${disciplineBlock(profile)}

${PROFESSIONAL_STYLE}
${contentLanguageGuidance(input.language)}`,
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
 "speakerNotes": string}`;

const SLIDE_BODY_RULES = `Body rules (the slide is 16:9 — everything must fit without scrolling):
- TITLE / SECTION slides: title + subtitle only.
- CONTENT, AGENDA, LEARNING_OUTCOMES, SUMMARY → 3-5 bullets, each 6-16 words, parallel grammar, informative (no filler,
  no "In this slide…"). Bold the one key term of a bullet with **term** (at most one bold run per bullet).
- DEFINITION → callout {label, text ≤ 35 words} + up to 2 bullets (property, non-example).
- FORMULA → formula {latex: valid KaTeX without $ delimiters (escape backslashes as \\\\ in JSON), explanation that names
  every symbol} + up to 2 bullets on when to use it.
- CODE → code {language (python, java, cpp, c, javascript, sql, shell…), source: ≤ 12 lines of real, runnable code,
  ≤ 60 characters per line, highlight: 1-3 line numbers the bullets discuss, output: what it prints when run (≤ 3 lines,
  omit when nothing is printed), caption: file name or short label} + 1-3 short bullets explaining the highlighted
  lines. Elide irrelevant lines with "…" instead of shrinking the font. Never put code in bullets, never pair code
  with a diagram.
- EXAMPLE → example {problem with concrete values/data, steps (2-4, each ≤ 20 words), solution with result + interpretation}.
- COMPARISON → leftColumn + rightColumn with matching aspects in the same order (3-4 bullets each); for 3+ items or
  several attributes use table {headers: 2-4 short, rows: 2-5, cells ≤ 6 words} with at most 2 bullets.
- CHECKPOINT / ACTIVITY → callout {label: "Checkpoint"|"Activity", text: one question or task}; speakerNotes starts with
  "Answer:" (checkpoint) or the expected outcome (activity).
- Visual "mermaid:<idea>" → diagram {title, mermaid} AND 1-3 short bullets. Mermaid: flowchart LR for a sequence of
  ≤ 5 steps, flowchart TD for a hierarchy (or sequenceDiagram / stateDiagram-v2 / classDiagram when clearly better);
  3-6 nodes and at most 4 levels so labels stay readable when projected; labels ≤ 4 words in double quotes, \\n for a
  line break, no HTML, no styling.
- REFERENCES → bullets: [] (the cited sources are inserted automatically from the course references).
- A layout engine measures every slide on the real 16:9 stage; text that does not fit is cut off. Beside a figure or
  diagram the text column is under half the width, so keep those bullets especially short.
- Visual "figure:<key>" → the reference figure is attached automatically; write 1-3 bullets on what to notice in it.
  Do not include a diagram.
- type and layout must be the matching pair, and the body must fill that layout's main element:
  CONTENT|DIAGRAM|CODE|AGENDA|SUMMARY → BULLETS, DEFINITION → DEFINITION, FORMULA → FORMULA_FOCUS, EXAMPLE → EXAMPLE_STEPS,
  COMPARISON → TWO_COLUMN (needs both columns), CHECKPOINT|ACTIVITY → QUOTE_CALLOUT. Never use TWO_COLUMN without columns
  or EXAMPLE_STEPS without a real worked example — such text is hidden on the slide.
- Every content slide shows readable text: a figure or diagram is never the whole slide.
- Say each thing once: never repeat the bullets inside the example/callout (or the other way round), and do not reuse
  sentences from other slides. No markdown other than **bold**.
- speakerNotes: 3-5 sentences the instructor says — explain the idea in plain words, give an analogy or real case,
  end with a transition to the next slide.
- Stay faithful to the reference excerpts and their terminology; never invent facts, numbers or citations.`;

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
- ${templateBlock(template)}

${disciplineBlock(profile)}

${PROFESSIONAL_STYLE}

${exemplars(profile)}
${contentLanguageGuidance(input.language)}`,
    user: `${courseBlock(input)}

${analysisBlock(analysis)}
Deck: ${plan.title}. Approach: ${plan.approach}

Deck flow (→ marks your slides):
${deckFlowBlock(outline, new Set(items.map((item) => item.index)))}

Section "${section.title}" — goal: ${section.goal}; key points: ${section.keyPoints.join(' / ')}

Slides to write:
${items.map((item) => slideLine(item, figureByKey)).join('\n')}

Reference excerpts for this section:
${excerptsBlock(excerpts, 16_000)}`,
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
- pedagogy: slide does not serve its CLO, missing example after a hard concept, checkpoint without a real question;
- layout: body too dense for a 16:9 slide, wrong element for the content (e.g. comparison written as plain bullets),
  a figure/diagram with no text telling students what to notice, a diagram that does not match its bullets or title,
  type/layout that does not fit the body (TWO_COLUMN shows only the columns, EXAMPLE_STEPS the worked example);
- coherence: repeats another slide, the same text twice on one slide (bullets copied into the example or callout),
  breaks the teaching order, inconsistent terminology;
- polish: headline is a topic label instead of a claim, the body does not prove the headline, mixed fragment and
  sentence bullets, hype or filler, vague quantities where the reference gives numbers.
Ask of every slide: "Would a senior professor project this as-is?" If not, say exactly what to change.
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
${contentLanguageGuidance(input.language)}`,
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
${contentLanguageGuidance(input.language)}`,
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
- A problem starting with "REJECTED REWRITE" lists what your previous rewrite of that slide broke; avoid it this time.
- Do not create new problems: keep every correct key point, keep the headline proven by the body and keep the slide
  within its rendered area.
- When a problem asks for the field's evidence (code, formula, worked example, table…), change the slide's type and
  layout to match the element you add (CODE → BULLETS, FORMULA → FORMULA_FOCUS, EXAMPLE → EXAMPLE_STEPS).
- ${templateBlock(template)}

${disciplineBlock(profile)}

${PROFESSIONAL_STYLE}

${exemplars(profile)}
${contentLanguageGuidance(input.language)}`,
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

export function illustratorPrompt(
  input: StudioInput,
  jobs: Array<{ n: number; title: string; idea: string; current: string | null; problems: string[] }>,
): PromptPair {
  return {
    system: `${TEAM}
You are the ILLUSTRATOR agent. You write Mermaid diagrams that render with mermaid v11.
Output NDJSON, one line per requested slide: {"n": integer, "title": string, "mermaid": string}. No prose, no code fences.
Rules: start with "flowchart LR" (sequences of ≤ 5 steps), "flowchart TD" (hierarchies), "sequenceDiagram",
"stateDiagram-v2", "classDiagram" or "timeline" (dated events: "timeline\\n    1932 : Event"); 3-6 nodes and at most 4 levels, because the diagram shares a 16:9 slide with text and
must stay readable from the back of a lecture hall; labels ≤ 4 words in double quotes; no HTML, no classDef/style
lines; use \\n inside JSON strings for line breaks.
${contentLanguageGuidance(input.language)}`,
    user: `Topic: ${input.topicTitle} (${input.courseTitle})

Diagrams to ${jobs.some((job) => job.current) ? 'create or fix' : 'create'}:
${jobs
  .map(
    (job) =>
      `n=${job.n} | slide "${job.title}" | idea: ${job.idea}${
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
You are the REVIEWER agent (quality assurance). Check the deck against the plan, the CLOs and the reference excerpts:
coverage, accuracy, clarity, progression, cognitive load, visual support and professional polish (assertion headlines,
consistent style, every "rendered:" line fits). Score as a demanding department head reviewing a colleague's lecture:
90+ only when the deck could be projected tomorrow without a single edit.
${disciplineAudit(profile)} Score a deck that teaches its field mostly in prose (no code for programming, no formulas
and worked examples for mathematics, no figures for sciences) below 80.
Slide-specific medium/high issues are sent back to the optimizer, so write each one as a concrete fix instruction
(what to change and to what) and give its slide number; use slide null only for deck-wide remarks.
Return ONLY one JSON object:
{"score": integer /* 0-100 */, "summary": string /* 2 sentences for the instructor */,
 "cloCoverage": [{"code": string, "slides": integer[]}],
 "issues": [{"slide": integer|null, "severity": "low"|"medium"|"high", "message": string}] /* at most 8, most important first */}
${contentLanguageGuidance(input.language)}`,
    user: `${courseBlock(input)}

Plan:
${planBlock(plan)}

Deck:
${deck}

Reference excerpts:
${excerptsBlock(excerpts, 12_000)}`,
  };
}
