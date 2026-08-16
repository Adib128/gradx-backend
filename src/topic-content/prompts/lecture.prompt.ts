import { ContentGenerationJob } from '../interfaces/content-generation-job.interface';
import { contentLanguageGuidance } from '../utils/content-language.util';
import { formatReferencesWithContentForPrompt } from './pedagogy.shared';

const formatReferenceCitation = (reference: unknown): string => {
  if (!reference) return '';
  if (typeof reference === 'string') return reference;
  if (typeof reference !== 'object') return String(reference);

  const ref = reference as Record<string, unknown>;
  const directCitation = ref.citation || ref.text;
  if (directCitation) return String(directCitation);

  return [ref.authors, ref.title, ref.publisher, ref.year]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
    .join('. ');
};

const formatReferences = (references: unknown[]) =>
  references.map(formatReferenceCitation).filter(Boolean);

export const LECTURE_SYSTEM_PROMPT = `You are an experienced university lecturer writing material that real instructors use in class.
Write in a clear academic teaching voice: precise terminology, careful definitions, sound pedagogy, and fully worked examples.
Prefer substance over flourish. Never use marketing language, hype, or vague AI filler.
Output must be valid JSON only.`;

export const LECTURE_PROMPT = (data: ContentGenerationJob): string => `
Generate university lecture notes that a professor can teach from and students can revise from.

## Course & Topic
- Course: ${data.courseTitle}
- Topic ${data.topicNumber}: ${data.topicTitle}
- Course description: ${data.courseDescription}

## Generation Profile
- Note type: ${data.courseNoteType}
- Audience: ${data.audience}
- Depth: ${data.contentDepth}
- Target length: ${data.length}
- Difficulty: ${data.difficulty}
- Quality mode: ${data.aiQualityMode}

## Course Learning Outcomes (CLOs)
${data.clos.map((c) => `- [${c.code}] ${c.description}`).join('\n') || '- (none provided)'}

### Priority CLO focus for this topic
${
  data.targetedCloIds.length
    ? data.targetedCloIds.map((id) => `- ${id}`).join('\n')
    : '- Emphasize the CLOs most relevant to this topic'
}

## Pedagogical Requirements (must satisfy)
1. Bloom levels to emphasize: ${data.bloomsTaxonomyLevels.join(', ') || 'Understand, Apply, Analyze'}
2. Required learning components: ${data.learningComponents.join(', ') || 'Learning Objectives, Detailed Explanation, Examples, Summary, Self-Assessment'}
3. Example contexts: ${data.exampleLevels.join(', ') || 'Academic, Industry'}
4. Visual styles: ${data.visuals.join(', ') || 'Concept Diagrams, Process Flow'}
5. Assessment formats to include: ${data.assessmentIntegrations.join(', ') || 'Short Answers, Exam Questions'}
6. Quality checks: ${data.humanReviewChecks.join(', ') || 'Fact Checking, CLO Alignment Check, Validate Definitions'}

${contentLanguageGuidance(data.contentLanguage)}

## Writing Standards for University Teaching
- Open with why the topic matters in the curriculum, then precise definitions, then intuition, then formalism, then practice.
- Use correct domain terminology consistently; define every non-obvious term the first time it appears.
- Include at least 2 fully worked examples with inputs, intermediate reasoning, and final answers (not outlines).
- Include at least 1 common student misconception and how to correct it in class.
- Include formative check questions with brief model answers suitable for in-class discussion.
- If formulas appear, write them as plain escaped text (no markdown fences), and explain each symbol.
- If diagrams help, provide valid Mermaid code that teaches structure, not decoration.
  Mermaid rules (a broken diagram is dropped from the lecture):
  * Start with "graph TD" or "graph LR"; every node label must be quoted: A["Label"], B{"Question?"}.
  * Node ids are single words with no spaces; give subgraphs an id too: subgraph S1["Forward Pass"].
  * Every arrow needs a target on the same line; write edge labels as A -->|"label"| B.
  * No LaTeX or backslashes inside labels (write "gradient of f" or "∇f", never "\\nabla"); no linkStyle, no note.
  * Only style ids you declared, never a multi-word title: style S1 fill:#eef.
- Map each module to CLO codes from the list above.
- Keep density high: no vague summaries, no placeholder text, no "as mentioned earlier" without content.
- Cite only from provided references when possible.
- When a reference includes source excerpts, ground definitions, examples, and terminology in that document content; do not invent conflicting facts.
- Course references / source excerpts:
${formatReferencesWithContentForPrompt(data.references || [])}
- Match the requested length "${data.length}" with real academic content, not padding.

## Output Rules
1. Return ONLY a raw JSON object (no markdown fences, no commentary).
2. Escape all double quotes and newlines inside strings.
3. For math, prefer plain wording such as "s_k multiplied by y_k transpose"; avoid unescaped special characters that break JSON.

## Required JSON Shape
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
    "abstract": "2-4 sentences stating what students will master and why it matters in this course.",
    "learningObjectives": [
      "Measurable objective mapped to Bloom verbs and CLO codes where possible"
    ],
    "prerequisiteKnowledgeCheck": [
      "Concrete prerequisite the student must already know"
    ],
    "suggestedClassFlow": [
      "Timed teaching segment, e.g. 15 min: concept + board derivation"
    ]
  },
  "modules": [
    {
      "moduleIndex": 1,
      "title": "Clear academic section title",
      "associatedCloIds": ${JSON.stringify(data.targetedCloIds)},
      "targetedBloomsLevels": ${JSON.stringify(data.bloomsTaxonomyLevels)},
      "theoreticalFoundations": {
        "formalDefinition": "Precise definition using standard academic wording for ${data.contentDepth}.",
        "firstPrinciplesDerivation": "Step-by-step derivation or conceptual construction with escaped formula strings.",
        "structuralInterpretation": "How the idea behaves in practice for contexts: ${data.exampleLevels.join('/') || 'Academic'}."
      },
      "algorithmicOrProcessBreakdown": {
        "stepByStepExecution": [
          "Step 1: actionable teaching step"
        ],
        "edgeCasesAndFailureModes": "Where beginners fail and how an instructor should address it."
      },
      "visualRepresentations": [
        {
          "visualProfileType": "${data.visuals[0] || 'Concept Diagrams'}",
          "diagramTitle": "Instructional diagram title",
          "mermaidDiagramCode": "graph TD\\nA[\\"Idea\\"] -->|\\"leads to\\"| B[\\"Consequence\\"]",
          "diagramPedagogicalExplanation": "What students should notice in the diagram."
        }
      ],
      "appliedDemonstrations": [
        {
          "contextStyle": "${data.exampleLevels[0] || 'Academic'}",
          "caseStudyTitle": "Worked classroom example title",
          "realWorldProblemContext": "Brief authentic scenario.",
          "concreteProblemStatement": "Complete problem with numbers/parameters.",
          "stepByStepSolution": "Full solution path with intermediate results.",
          "executableArtifactSnippet": "ONLY when real code/pseudocode/procedure is pedagogically useful; otherwise omit this field entirely.",
          "artifactTypeOrLanguage": "python | pseudocode | procedure — omit when no snippet"
        }
      ],
      "professorSpeakingNotes": [
        "What to emphasize verbally / write on the board",
        "Likely misconception and correction script"
      ],
      "formativeChecks": [
        {
          "prompt": "Quick in-class question",
          "modelAnswer": "Short correct answer with reasoning"
        }
      ],
      "moduleKeyTakeaways": [
        "Durable takeaway students should remember"
      ]
    }
  ],
  "comprehensiveAssessment": [
    {
      "enforcedAssessmentFormats": ${JSON.stringify(data.assessmentIntegrations)},
      "questionType": "Exam-quality item matching difficulty ${data.difficulty}",
      "questionStatement": "Complete question text.",
      "solvingHint": "Targeted hint without giving away the full answer.",
      "exhaustiveAnswerKey": "Full marking solution with rubric-worthy steps."
    }
  ],
  "providedReferences": ${JSON.stringify(formatReferences(data.references))}
}

Rules:
- Generate at least 3 substantial modules unless the topic is extremely narrow. Every module must contain real teaching content, not stubs.
- Do NOT include an academicReviewVerification object.
- For appliedDemonstrations.executableArtifactSnippet: only include real code, pseudocode, or a structured procedure when it genuinely helps teaching. For non-technical subjects (e.g. marketing, business, humanities), OMIT executableArtifactSnippet and artifactTypeOrLanguage entirely. Never invent TypeScript/Python stubs or write "N/A".
`;
