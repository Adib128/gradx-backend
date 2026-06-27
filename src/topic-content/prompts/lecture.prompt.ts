import { ContentGenerationJob } from '../interfaces/content-generation-job.interface';

const formatReferenceCitation = (reference: unknown): string => {
  if (!reference) return '';
  if (typeof reference === 'string') return reference;
  if (typeof reference !== 'object') return String(reference);

  const ref = reference as Record<string, unknown>;
  const directCitation = ref.citation || ref.text;
  if (directCitation) return String(directCitation);

  return [
    ref.authors,
    ref.title,
    ref.publisher,
    ref.year,
  ]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
    .join('. ');
};

const formatReferences = (references: unknown[]) =>
  references.map(formatReferenceCitation).filter(Boolean);

export const LECTURE_PROMPT = (data: ContentGenerationJob): string => `
You are an elite university professor and instructional designer. Generate comprehensive, publication-quality lecture notes providing a rigorous lesson on the target topic. Focus entirely on deep academic substance and compact, high-density technical value.

## Academic & Course Context
- **Course Title:** ${data.courseTitle}
- **Topic ${data.topicNumber}:** ${data.topicTitle}
- **Course Overview & Scope:** ${data.courseDescription}

## Tailored Generation Configurations
- **Note Type Focus:** ${data.courseNoteType}
- **Target Audience:** ${data.audience}
- **Content Complexity Depth:** ${data.contentDepth}
- **Expected Length Scale:** ${data.length}
- **Content Difficulty Tier:** ${data.difficulty}
- **AI Processing Priority Profile:** ${data.aiQualityMode}

## Target Course Learning Outcomes (CLOs)
Explicitly weave the broad CLOs throughout the content fabric:
${data.clos.map((c) => `- [${c.code}] (${c.code}): ${c.description}`).join('\n')}

### Strict Priority CLO Focus
The user has manually isolated and flagged specific Target Outcomes for this content package. You MUST heavily emphasize and explicitly prioritize the following mappings inside the pedagogical modules:
${data.targetedCloIds.map((id) => `- Target Focus ID Reference: ${id}`).join('\n')}

## Required Pedagogical & Design Matrix Rules
1. **Bloom's Taxonomy Alignment:** Ensure the learning pathways, explanations, and checkpoints target these cognitive levels explicitly: ${data.bloomsTaxonomyLevels.join(', ')}.
2. **Mandatory Learning Components:** You must include structured data/sections for each of these requested component modules: ${data.learningComponents.join(', ')}.
3. **Example Strategy Profiles:** Frame all implementations, use cases, and problem domains around these context depths: ${data.exampleLevels.join(', ')}.
4. **Visual Implementations:** Incorporate structured visualization concepts matching these profiles: ${data.visuals.join(', ')}.
5. **Assessment Vectors:** Structure your comprehensive assessment blocks using these specific formats: ${data.assessmentIntegrations.join(', ')}.
6. **Academic Review Compliance:** Pre-verify that the generated content fully satisfies these strict automated quality controls: ${data.humanReviewChecks.join(', ')}.

## Operational Constraints & Formatting Rules (CRITICAL FOR PARSING)
1. **JSON Integrity:** Return ONLY a raw, valid JSON object. Do not wrap in markdown code blocks (\`\`\`json). No preambles or postscripts.
2. **Strict Escaping Rules:** You MUST strictly escape all double quotes (\\") and all internal newlines (\\\\n) inside text blocks. 
3. **Math String Safety:** When outputting algebraic equations, matrix operations, or multiplications (e.g., dot products or matrix updates like s_k * y_k^T), use word descriptions or plain text formats (e.g., "s_k multiplied by y_k transpose"). Do not use unescaped asterisks or mathematical brackets that can disrupt structural string processing.
4. **Pedagogical Density Over Verbosity:** Do not summarize, skip steps, or use placeholders. Be concise but conceptually exhaustive matching the requested "${data.length}" constraint.

## Expected JSON Schema Output Structure
Match this structural signature exactly:

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
    "abstract": "Provide a dense academic abstract framing the topic's systemic necessity and industry importance tailored to an ${data.audience} audience.",
    "learningObjectives": [
      "Incorporate mandatory aspects targeting: ${data.learningComponents.join(', ')}"
    ],
    "prerequisiteKnowledgeCheck": [
      "Explicit foundational concepts or prerequisite technical skills required to grasp this material."
    ]
  },
  "modules": [
    {
      "moduleIndex": 1,
      "title": "Core Analytical Principles and Structural Frameworks",
      "associatedCloIds": ${JSON.stringify(data.targetedCloIds)},
      "targetedBloomsLevels": ${JSON.stringify(data.bloomsTaxonomyLevels)},
      "theoreticalFoundations": {
        "formalDefinition": "Provide a definitive, high-density statement defining the concept using strict terminology suited for ${data.contentDepth} depth.",
        "firstPrinciplesDerivation": "A focused, step-by-step logical, mathematical, or empirical derivation of the strategic framework or formula from underlying principles. Ensure any equations are completely escaped safe strings.",
        "structuralInterpretation": "Explain precisely how this concept operates dynamically matching the ${data.exampleLevels.join('/')} contexts."
      },
      "algorithmicOrProcessBreakdown": {
        "stepByStepExecution": [
          "Step 1: Initial operational phase or baseline configuration parameters."
        ],
        "edgeCasesAndFailureModes": "Detail exactly where this framework breaks down in practice and the explicit mitigation techniques experts use."
      },
      "visualRepresentations": [
        {
          "visualProfileType": "Must target: ${data.visuals.join('/')}",
          "diagramTitle": "System Architecture / Process Flow Chart",
          "mermaidDiagramCode": "graph TD; A[State A] --> B[State B];",
          "diagramPedagogicalExplanation": "A detailed technical breakdown of how the visual paths in the Mermaid diagram align with the operational modules."
        }
      ],
      "appliedDemonstrations": [
        {
          "contextStyle": "Configured to match: ${data.exampleLevels.join('/')}",
          "caseStudyTitle": "Comprehensive Real-World Implementation Case Study",
          "realWorldProblemContext": "Describe an operational scenario where this topic serves as a critical focus.",
          "concreteProblemStatement": "State a complete problem scenario with explicit data points or parameters.",
          "stepByStepSolution": "Provide a clear, unabridged solution path showing key calculations or strategic moves.",
          "executableArtifactSnippet": "Provide code blocks or configuration schemas (e.g. JSON/YAML) if technical, or a structured architectural blueprint markdown list if conceptual.",
          "artifactTypeOrLanguage": "Identify the syntax formatting wrapper language used."
        }
      ],
      "professorSpeakingNotes": [
        "Whiteboard Plan: Specify exactly what to diagram or outline on the board.",
        "Student Misconception: Highlight a severe, frequent misunderstanding students have regarding this specific layout."
      ],
      "moduleKeyTakeaways": [
        "Core academic or verification takeaways."
      ]
    }
  ],
  "comprehensiveAssessment": [
    {
      "enforcedAssessmentFormats": ${JSON.stringify(data.assessmentIntegrations)},
      "questionType": "Targeting ${data.difficulty} evaluation challenge",
      "questionStatement": "State an exam-quality question matching the targeted strategies.",
      "solvingHint": "Provide a tactical hint highlighting the specific core model, metric, or paradigm required to unlock the answer.",
      "exhaustiveAnswerKey": "Provide the complete, step-by-step solution path including all transitions or justifications."
    }
  ],
  "providedReferences": ${JSON.stringify(formatReferences(data.references))},
  "academicReviewVerification": {
    "checksPassed": ${JSON.stringify(data.humanReviewChecks)},
    "status": "VERIFIED_COMPLIANT"
  }
}`;
