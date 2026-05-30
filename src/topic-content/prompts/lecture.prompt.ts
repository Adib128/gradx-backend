import { ContentGenerationJob } from '../interfaces/content-generation-job.interface';

export const LECTURE_PROMPT = (data: ContentGenerationJob): string => `
You are an elite university professor and instructional designer. Generate comprehensive, publication-quality lecture notes providing a rigorous 3-hour lesson on the target topic. Focus entirely on deep academic substance and compact, high-density technical value.

## Academic & Course Context
- **Course Title:** ${data.courseTitle}
- **Topic ${data.topicNumber}:** ${data.topicTitle}
- **Course Overview & Scope:** ${data.courseDescription}

## Target Course Learning Outcomes (CLOs)
Explicitly weave these CLOs throughout the content fabric:
${data.clos.map((c) => `- [${c.code}] (${c.category}): ${c.description}`).join('\n')}

## Operational Constraints & Formatting Rules
1. **JSON Integrity:** Return ONLY a raw, valid JSON object. Do not wrap in markdown code blocks (\`\`\`json). No preambles or postscripts.
2. **Strict Escaping Rules:** Escape all double quotes (\") and newlines (\\n) inside text blocks.
3. **Flexible Math Notation:** - **STEM/Technical**: Use text-based math expressions (e.g., "theta", "sigma", "partial f / partial y^2", "matrix transpose A^T"). Do NOT use raw LaTeX backslashes (\\).
   - **Non-STEM/Narrative**: Avoid forced formulas; use formal structural frameworks, industry methodologies, or systematic models.
4. **Pedagogical Density Over Verbosity:** Do not summarize, skip steps, or use placeholders. Be concise but conceptually exhaustive.

## Expected JSON Schema Output Structure
Match this structural signature exactly:

{
  "metadata": {
    "targetTopic": "${data.topicTitle}",
    "estimatedLectureDurationMinutes": 180,
    "pedagogicalFramework": "Constructivist alignment mapping directly to course performance criteria."
  },
  "lectureOverview": {
    "abstract": "Provide a dense, exactly 2-paragraph academic abstract framing the topic's systemic necessity, operational value, and industry importance.",
    "learningObjectives": [
      "Objective 1: Deconstruct the fundamental principles, mechanisms, or core theories underlying this topic.",
      "Objective 2: Analyze real-world failure modes, strategic implementation constraints, or analytical processes connected to this domain."
    ],
    "prerequisiteKnowledgeCheck": [
      "Prerequisite 1: Explicit foundational concepts, industry paradigms, or prerequisite technical skills required to grasp this material."
    ]
  },
  "modules": [
    {
      "moduleIndex": 1,
      "title": "Historical Context, Foundational Principles, and Structural Frameworks",
      "associatedCloCodes": ["${data.clos[0]?.code ?? 'CLO-1'}"],
      "theoreticalFoundations": {
        "formalDefinition": "Provide a definitive, high-density 2-sentence statement defining the concept using strict technical, mathematical, legal, or industry-standard terminology.",
        "firstPrinciplesDerivation": "A focused, step-by-step logical, mathematical, or empirical derivation of the strategic framework or formula from underlying principles.",
        "structuralInterpretation": "Explain precisely how this concept operates dynamically (e.g., architectural layers, corporate value chains, market dynamics, or multi-dimensional spaces)."
      },
      "algorithmicOrProcessBreakdown": {
        "stepByStepExecution": [
          "Step 1: Initial operational phase, assessment setup, or boundary configuration.",
          "Step 2: Core processing layer, iterative analysis milestone, or strategic validation metrics."
        ],
        "edgeCasesAndFailureModes": "Detail exactly where this framework breaks down in practice (e.g., scale bottlenecks, non-convex constraints, cognitive biases) and the explicit mitigation techniques experts use."
      },
      "visualRepresentations": [
        {
          "diagramTitle": "System Architecture / Process Flow Chart",
          "mermaidDiagramCode": "graph TD; A[State A] --> B[State B];",
          "diagramPedagogicalExplanation": "A detailed technical breakdown of how the visual paths in the Mermaid diagram align with the operational modules."
        }
      ],
      "appliedDemonstrations": [
        {
          "caseStudyTitle": "Comprehensive Real-World Implementation Case Study",
          "realWorldProblemContext": "Describe an enterprise, industrial, or scientific scenario where this topic serves as a critical operational bottleneck.",
          "concreteProblemStatement": "State a complete problem scenario with explicit data points, operational parameters, or system constraints.",
          "stepByStepSolution": "Provide a clear, unabridged solution path showing key calculations, policy decisions, or strategic moves.",
          "executableArtifactSnippet": "Provide either: (a) Clean, industry-grade source code for technical topics, OR (b) A structured strategic template, markdown checklist, or architectural blueprint.",
          "artifactTypeOrLanguage": "Identify the type of snippet provided (e.g., 'python', 'typescript', 'markdown', 'yaml')."
        }
      ],
      "professorSpeakingNotes": [
        "Whiteboard Plan: Specify exactly what to diagram or outline on the board and which core variables to emphasize.",
        "Student Misconception: Highlight a severe, frequent misunderstanding students have when applying this concept in field environments."
      ],
      "moduleKeyTakeaways": [
        "Takeaway 1: Core academic or validation accuracy.",
        "Takeaway 2: Immediate industry implementation and application."
      ]
    }
  ],
  "comprehensiveAssessment": [
    {
      "questionType": "Analytical Proof / Comprehensive Case Analysis",
      "targetCloCode": "${data.clos[0]?.code ?? 'CLO-1'}",
      "questionStatement": "State a highly challenging, exam-quality question requiring mathematical verification, critical architectural deduction, or strategic evaluation.",
      "solvingHint": "Provide a tactical hint highlighting the specific core theorem, model, matrix property, or business paradigm required to unlock the answer.",
      "exhaustiveAnswerKey": "Provide the complete, step-by-step solution path including all structural transitions, formulations, or corporate strategy justifications."
    }
  ],
  "curatedAcademicReferences": [
    {
      "literatureTitle": "Standard Authoritative Text or Industry Standard Blueprint",
      "authorsAndAffiliation": "Full author credentials, publication source, or institutional affiliation.",
      "directResourceUrl": "https://example.com/authoritative-source"
    }
  ]
}`;
