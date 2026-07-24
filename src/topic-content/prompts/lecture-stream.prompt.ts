import { ContentGenerationJob } from '../interfaces/content-generation-job.interface';

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

## CLOs
${data.clos.map((c) => `- [${c.code}] ${c.description}`).join('\n') || '- (none provided)'}

### Priority CLO focus
${
  data.targetedCloIds.length
    ? data.targetedCloIds.map((id) => `- ${id}`).join('\n')
    : '- Emphasize CLOs most relevant to this topic'
}
`;

export const LECTURE_STREAM_SYSTEM = `You are an experienced university lecturer.
Write clear academic teaching content. Return valid JSON only — no markdown fences.`;

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
    "learningObjectives": ["Measurable objective with Bloom verb"],
    "prerequisiteKnowledgeCheck": ["Concrete prerequisite"],
    "suggestedClassFlow": ["Timed teaching segment"]
  }
}
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
- Bloom levels: ${data.bloomsTaxonomyLevels.join(', ') || 'Understand, Apply, Analyze'}
- Example contexts: ${data.exampleLevels.join(', ') || 'Academic, Industry'}
- Visuals: ${data.visuals.join(', ') || 'Concept Diagrams'}

Rules:
- Full teaching substance: definition → intuition → formalism/process → worked example → misconception → formative check.
- Include at least one fully worked example with concrete values.
- Escape strings for valid JSON. No markdown fences.
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
      "executableArtifactSnippet": string,
      "artifactTypeOrLanguage": string
    }
  ],
  "professorSpeakingNotes": [string],
  "formativeChecks": [
    { "prompt": string, "modelAnswer": string }
  ],
  "moduleKeyTakeaways": [string]
}
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
      "exhaustiveAnswerKey": string
    }
  ],
  "providedReferences": [string],
  "academicReviewVerification": {
    "checksPassed": ${JSON.stringify(data.humanReviewChecks)},
    "status": "VERIFIED_COMPLIANT"
  }
}

Include at least 2 exam-quality assessment items matching difficulty ${data.difficulty}.
`;
