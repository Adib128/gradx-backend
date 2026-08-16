import { ContentGenerationJob } from '../interfaces/content-generation-job.interface';
import {
  SAUDI_UNIVERSITY_PEDAGOGY,
  formatClosForPrompt,
  localContextGuidance,
  languageBlock,
  qualityModeGuidance,
  formatReferencesWithContentForPrompt,
} from './pedagogy.shared';

const contextBlock = (data: ContentGenerationJob) => `
## Course & Topic
- Course: ${data.courseTitle}
- Topic ${data.topicNumber}: ${data.topicTitle}
- Course description: ${data.courseDescription}

## Profile
- Audience: ${data.audience}
- Depth: ${data.contentDepth}
- Difficulty: ${data.difficulty}
- Note type: ${data.courseNoteType}
- Length: ${data.length}
- ${qualityModeGuidance(data.aiQualityMode)}

## CLOs (constructive alignment)
${formatClosForPrompt(data.clos, data.targetedCloIds)}

### Priority CLO focus
${
  data.targetedCloIds.length
    ? data.targetedCloIds.map((id) => `- ${id}`).join('\n')
    : '- Emphasize CLOs most relevant to this topic'
}

## Course references (cite + use attached source text when present)
${formatReferencesWithContentForPrompt(data.references || [])}

${localContextGuidance(data.exampleLevels)}

${languageBlock(data)}
`;

export const LECTURE_STREAM_SYSTEM = `You are an experienced university lecturer who designs NCAAA-aligned course topics for Saudi and Gulf higher education.
Write clear academic teaching content a professor can deliver in class.
${SAUDI_UNIVERSITY_PEDAGOGY}
Return valid JSON only — no markdown fences.`;

export const LECTURE_PLAN_PROMPT = (data: ContentGenerationJob) => `
Plan a university lecture outline for this topic.
${contextBlock(data)}

Return ONLY JSON:
{
  "moduleCount": number,
  "modules": [
    { "moduleIndex": 1, "title": "Clear academic section title" }
  ]
}

Rules:
- moduleCount between 3 and 5 unless the topic is extremely narrow (then 2).
- Titles must be teachable classroom sections, not marketing slogans.
- Sequence for constructive alignment: motivation/why → core concepts → methods/formalism → application → synthesis.
- Each module title should make the CLO focus obvious to a faculty reviewer.
`;

export const LECTURE_OVERVIEW_PROMPT = (
  data: ContentGenerationJob,
  plan: { modules: Array<{ moduleIndex: number; title: string }> },
) => `
Write the lecture overview for this university topic.
${contextBlock(data)}

## Planned modules
${plan.modules.map((m) => `${m.moduleIndex}. ${m.title}`).join('\n')}

Return ONLY JSON:
{
  "metadata": {
    "targetTopic": "${data.topicTitle}",
    "noteType": "${data.courseNoteType}",
    "audienceTier": "${data.audience}",
    "depthProfile": "${data.contentDepth}",
    "difficultyLevel": "${data.difficulty}",
    "qualityComplianceMode": "${data.aiQualityMode}"
  },
  "lectureOverview": {
    "abstract": "2-4 sentences: what students will master and why it matters in this course.",
    "learningObjectives": ["Measurable objective with Bloom verb, ideally tagged to a CLO code"],
    "prerequisiteKnowledgeCheck": ["Concrete prerequisite"],
    "suggestedClassFlow": ["Timed teaching segment that a Saudi university instructor can follow"]
  }
}

Rules:
- Learning objectives must be measurable and use Bloom verbs matching: ${data.bloomsTaxonomyLevels.join(', ') || 'Understand, Apply, Analyze, Evaluate'}.
- suggestedClassFlow should total a realistic single session or two-session plan with minutes.
`;

export const LECTURE_MODULE_PROMPT = (
  data: ContentGenerationJob,
  planModule: { moduleIndex: number; title: string },
  priorModuleTitles: string[],
) => `
Write ONE complete lecture module for classroom teaching.
${contextBlock(data)}

## This module
- Index: ${planModule.moduleIndex}
- Title: ${planModule.title}

## Earlier modules already covered
${priorModuleTitles.length ? priorModuleTitles.map((t, i) => `${i + 1}. ${t}`).join('\n') : '- (this is the first module)'}

## Pedagogical requirements
- Bloom levels: ${data.bloomsTaxonomyLevels.join(', ') || 'Understand, Apply, Analyze, Evaluate'}
- Example contexts: ${data.exampleLevels.join(', ') || 'Academic, Industry'}
- Visuals: ${data.visuals.join(', ') || 'Concept Diagrams'}
- Faculty review intent (design toward these checks; do not claim automated verification): ${(data.humanReviewChecks || []).join(', ') || 'CLO Alignment Check, Validate Definitions'}

Rules:
- Full teaching substance: definition → intuition → formalism/process → worked example → misconception → formative check.
- Include at least one fully worked example with concrete values.
- Map this module explicitly to the most relevant priority CLO(s); respect teachingStrategies/assessmentMethods when provided.
- Escape strings for valid JSON. No markdown fences.
- mermaidDiagramCode must parse (a broken diagram is dropped): start with "graph TD" or "graph LR",
  quote every label (A["Label"], B{"Question?"}), use single-word node ids, give subgraphs an id
  (subgraph S1["Forward Pass"]), write edge labels as A -->|"label"| B, never leave an arrow without a
  target, never put LaTeX backslashes in a label (write "∇f", not "\\nabla f"), and emit no linkStyle or note lines.
- Associated CLO ids: ${JSON.stringify(data.targetedCloIds)}

Return ONLY JSON for this single module object:
{
  "moduleIndex": ${planModule.moduleIndex},
  "title": "${planModule.title}",
  "associatedCloIds": ${JSON.stringify(data.targetedCloIds)},
  "targetedBloomsLevels": ${JSON.stringify(data.bloomsTaxonomyLevels)},
  "theoreticalFoundations": {
    "formalDefinition": string,
    "firstPrinciplesDerivation": string,
    "structuralInterpretation": string
  },
  "algorithmicOrProcessBreakdown": {
    "stepByStepExecution": [string],
    "edgeCasesAndFailureModes": string
  },
  "visualRepresentations": [
    {
      "visualProfileType": string,
      "diagramTitle": string,
      "mermaidDiagramCode": string,
      "diagramPedagogicalExplanation": string
    }
  ],
  "appliedDemonstrations": [
    {
      "contextStyle": string,
      "caseStudyTitle": string,
      "realWorldProblemContext": string,
      "concreteProblemStatement": string,
      "stepByStepSolution": string,
      "executableArtifactSnippet": "optional — real code/pseudocode/procedure only; omit for non-technical subjects",
      "artifactTypeOrLanguage": "optional — omit when no snippet"
    }
  ],
  "professorSpeakingNotes": [string],
  "formativeChecks": [
    { "prompt": string, "modelAnswer": string, "alignedCloCode": string }
  ],
  "moduleKeyTakeaways": [string]
}

Rules for this module:
- Never invent TypeScript/Python/code stubs or write "N/A" in executableArtifactSnippet.
- For marketing, business, humanities, and other non-coding topics, omit executableArtifactSnippet and artifactTypeOrLanguage entirely.
`;

export const LECTURE_CLOSING_PROMPT = (
  data: ContentGenerationJob,
  modules: Array<{ moduleIndex: number; title: string }>,
) => `
Write the closing assessment and references section for this lecture.
${contextBlock(data)}

## Modules covered
${modules.map((m) => `${m.moduleIndex}. ${m.title}`).join('\n')}

## Assessment formats
${data.assessmentIntegrations.join(', ') || 'Short Answers, Exam Questions'}

Return ONLY JSON:
{
  "comprehensiveAssessment": [
    {
      "enforcedAssessmentFormats": ${JSON.stringify(data.assessmentIntegrations)},
      "questionType": string,
      "questionStatement": string,
      "solvingHint": string,
      "exhaustiveAnswerKey": string,
      "alignedCloCode": string,
      "bloomsLevel": string
    }
  ],
  "providedReferences": [string]
}

Rules:
- Include at least 2 exam-quality assessment items matching difficulty ${data.difficulty}.
- Each item must align to a listed CLO code and an appropriate Bloom level.
- Do NOT invent references; only list references that were provided or are standard textbooks clearly implied by the course.
- Do NOT include an academicReviewVerification object.
`;
