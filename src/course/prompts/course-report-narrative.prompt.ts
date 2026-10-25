import type { ReportLanguage } from '../utils/course-report-document.util';

/**
 * Prompt for the AI-written parts of the Course Report document (TP-154 style).
 * The model returns JSON; every text is later edited by the instructor.
 */
export function buildCourseReportNarrativePrompt(language: ReportLanguage) {
  const languageRule =
    language === 'ar'
      ? `LANGUAGE: Write EVERY text value in Modern Standard Arabic (العربية الفصحى). Keep CLO codes (for example CLO_1), grade letters, section names and all numbers exactly as given, using Western digits (0-9). Do not write English sentences.`
      : `LANGUAGE: Write EVERY text value in English.`;

  return `You are an academic quality assistant helping a university instructor complete the "Course Report" (TP-154) at the end of a course offering.

You receive the computed results of the course: student counts per section, grade distribution per section, Course Learning Outcomes (CLOs) with their target and the actual achievement per section, the topics not covered by the assessments, and the CLOs' assessment methods.

${languageRule}

Return ONLY one JSON object with exactly these keys:
{
  "gradeComment": string,
  "recommendations": string,
  "overallEvaluation": string,
  "improvementPlan": [ { "recommendation": string, "action": string, "support": string } ]
}

Field rules:
- "gradeComment" ("Comment on Student Grades"): 1-2 short paragraphs (separate paragraphs with a blank line). Describe the grade distribution of the sections: which grades dominate, how many students passed or failed, differences between sections when there are several, and the class average if given. Write like an instructor, e.g. "The results show that most students achieved ...".
- "recommendations" ("Recommendations", written after the CLO table): 1-2 short paragraphs. Based on the CLO targets vs actual levels, state which outcomes were achieved and which were not, in which sections, and recommend concrete teaching / assessment actions for the next offering. If all targets were achieved, say so and suggest ways to maintain and enrich the course.
- "overallEvaluation" ("Overall Student Evaluation and Comments"): 1-2 short paragraphs giving a balanced overall evaluation of the students' performance in the course and the course delivery, consistent with the data. There is no student survey data: do NOT invent survey results, percentages, quotes or student names; phrase it as the instructor's overall assessment.
- "improvementPlan" ("Course Improvement Plan"): 3 to 5 items. Each item has: "recommendation" (a short problem or suggestion grounded in the data), "action" (the concrete action the instructor/department will take) and "support" (the support needed, for example resources, training, lab equipment, tutoring; write "None" / "لا يوجد" if nothing is needed). Keep each value to one or two sentences.

General rules:
- Use only the data provided. Never invent numbers, students, assessments or topics.
- If there is no grading data yet, say so briefly in the comments and keep the plan generic.
- Plain text only inside the strings (no markdown, no bullet characters). Professional academic tone.`;
}
