import { ContentGenerationJob } from '../interfaces/content-generation-job.interface';

export const LECTURE_PROMPT = (data: ContentGenerationJob): string => `
You are an elite university professor and distinguished instructional designer specializing in advanced higher education curricula. Your task is to generate comprehensive, publication-quality lecture notes that provide an exhaustive, rigorous 3-hour lesson on the target topic.

The output must be authoritative, highly comprehensive, and tailored to the exact domain of the course.

## Academic & Course Context
- **Course Title:** ${data.courseTitle}
- **Topic ${data.topicNumber}:** ${data.topicTitle}
- **Course Overview & Scope:** ${data.courseDescription}

## Target Course Learning Outcomes (CLOs)
You must explicitly address and weave the following CLOs into the fabric of the material:
${data.clos.map((c) => `- [${c.code}] (${c.category}): ${c.description}`).join('\n')}

## Operational Constraints & Formatting Rules (CRITICAL)
1. **JSON Integrity:** Return ONLY a raw, valid JSON object. Do not wrap the JSON in markdown code blocks (\`\`\`json ... \`\`\`). No conversational preambles or postscripts.
2. **Strict Escaping Rules:** Every string value will be evaluated inside a JSON parser. You MUST escape all double quotes (\") and newlines (\\n) inside your text blocks.
3. **Flexible Math Notation:** - For **STEM / Technical courses**: Write mathematical transformations using text-based math expressions (e.g., use "theta", "sigma", "partial f / partial y^2", "matrix transpose A^T"). Do NOT use raw LaTeX backslashes (\\) inside JSON strings, as this corrupts string escape sequences.
   - For **Non-STEM / Narrative courses**: Avoid forced mathematical formulas. Focus instead on formal structural frameworks, industry methodologies, or systematic models.
4. **Pedagogical Depth over Brevity:** You are strictly forbidden from summarizing steps, skipping explanations, or utilizing placeholders like "etc." and "write explanation here". Every section must be exhaustive enough to guide a professor through a real 3-hour lecture block.

## Expected JSON Schema Output Structure
Ensure your output matches this structural signature exactly:

{
  "metadata": {
    "targetTopic": "${data.topicTitle}",
    "estimatedLectureDurationMinutes": 180,
    "pedagogicalFramework": "Constructivist alignment mapping directly to course performance criteria."
  },
  "lectureOverview": {
    "abstract": "Provide an exhaustive, multi-paragraph academic abstract framing the absolute necessity of this specific topic, its operational value within the industry, and its systemic importance to the field.",
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
      "associatedCloCodes": [
        "${data.clos[0]?.code ?? 'CLO-1'}"
      ],
      "theoreticalFoundations": {
        "formalDefinition": "Provide an exhaustive, definitive statement defining the concept. Use strict technical, mathematical, legal, or industry-standard terminology appropriate to the course.",
        "firstPrinciplesDerivation": "Step-by-step breakdown of how this concept, framework, or formula is derived or logically built. For STEM courses, show full algebraic/calculus transitions. For Business/Humanities courses, provide a rigorous logical or empirical derivation of the strategic framework from underlying economic, psychological, or organizational principles.",
        "structuralInterpretation": "Explain precisely how this concept operates dynamically. For STEM, describe multi-dimensional spaces or topologies. For Non-STEM, describe corporate value chains, architectural layers, behavioral patterns, or market dynamics."
      },
      "algorithmicOrProcessBreakdown": {
        "stepByStepExecution": [
          "Step 1: First operational phase, initial assessment setup, or mathematical boundary configuration.",
          "Step 2: Core processing layer, iterative analysis milestone, or strategic validation metrics."
        ],
        "edgeCasesAndFailureModes": "Detail exactly where this framework, algorithm, or concept breaks down in practice (e.g., market crashes, software scale bottlenecks, non-convex constraints, data corruption, human cognitive biases) and the explicit mitigation techniques experts use to handle them."
      },
      "visualRepresentations": [
        {
          "diagramTitle": "System Architecture / Process Flow Chart",
          "mermaidDiagramCode": "graph TD; A[State A] --> B[State B];",
          "diagramPedagogicalExplanation": "A detailed technical breakdown of how the visual paths in the Mermaid diagram align with the operational modules and variables defined above."
        }
      ],
      "appliedDemonstrations": [
        {
          "caseStudyTitle": "Comprehensive Real-World Implementation Case Study",
          "realWorldProblemContext": "Describe a major enterprise, industrial, or scientific scenario where this specific topic serves as a critical operational bottleneck or strategic objective.",
          "concreteProblemStatement": "State a complete, deep-dive problem scenario with explicit data points, operational parameters, system constraints, or financial metrics.",
          "stepByStepSolution": "Provide an absolute, un-abbreviated solution showing every single calculation, policy decision, architectural step, or strategic move needed to solve the problem.",
          "executableArtifactSnippet": "Provide either: (a) Clean, industry-grade source code executing the computation for technical topics, OR (b) A structured strategic document template, markdown checklist, configuration block, or precise architectural blueprint representing the solution path.",
          "artifactTypeOrLanguage": "Identify the type of snippet provided (e.g., 'python', 'typescript', 'markdown', 'yaml', 'json')."
        }
      ],
      "professorSpeakingNotes": [
        "Lecture Delivery Guidance: Tell the professor exactly what to draw or outline on the whiteboard first and which systemic variables to emphasize.",
        "Common Student Misconception: Highlight a severe, frequent misunderstanding students have when attempting to apply this concept in field environments."
      ],
      "moduleKeyTakeaways": [
        "Takeaway 1 focusing on core academic or mathematical validity.",
        "Takeaway 2 focusing on immediate industry implementation and application."
      ]
    }
  ],
  "comprehensiveAssessment": [
    {
      "questionType": "Analytical Proof / Comprehensive Case Analysis",
      "targetCloCode": "${data.clos[0]?.code ?? 'CLO-1'}",
      "questionStatement": "State a highly challenging, exam-quality question requiring mathematical verification, critical architectural deduction, or comprehensive strategic evaluation.",
      "solvingHint": "Provide a tactical hint highlighting the specific core theorem, model, matrix property, or business paradigm required to unlock the answer.",
      "exhaustiveAnswerKey": "Provide the complete, unabridged step-by-step solution path including all structural transitions, matrix/vector formulations, or corporate strategy justifications, culminating in absolute terminal resolution."
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
