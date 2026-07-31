export const EXTRACT_COURSE_PROMPT = `
You are an expert academic data extractor.
Extract the course specification data from this PDF and return ONLY a valid JSON object.
Do NOT include any markdown, explanation, or extra text — just raw JSON.

Make sure to map the relationship between topics and Course Learning Outcomes (CLOs) by populating the "mappedClos" array inside each topic with the matching CLO codes, corresponding to the CLO-Topic matrix found in the document.

CRITICAL — CLO field mapping (do not swap these):
- "code" = the course CLO number from the CLO table (e.g. "1.1", "1.2", "2.1", "2.2", "3.1"). NEVER put K1/S1/V1 here.
- "programCLOCode" = the aligned program learning outcome code (e.g. "K1", "K2", "S1", "S2", "V1", "V2"). Put alignment codes ONLY here.
- "category" = "KNOWLEDGE" | "SKILLS" | "VALUES" matching the CLO domain.
- Topic "mappedClos" must reference "code" values (e.g. ["1.1", "2.1"]), NOT programCLOCode values.

Example CLO rows:

"clos": [
  { "code": "1.1", "category": "KNOWLEDGE", "programCLOCode": "K1", "description": "...", "teachingStrategies": ["Lectures"], "assessmentMethods": ["MidTermExam", "Final Exam"] },
  { "code": "1.2", "category": "KNOWLEDGE", "programCLOCode": "K2", "description": "...", "teachingStrategies": ["Lectures"], "assessmentMethods": ["Quizzes"] },
  { "code": "2.1", "category": "SKILLS", "programCLOCode": "S1", "description": "...", "teachingStrategies": ["Lab Activities"], "assessmentMethods": ["Lab Assignments"] },
  { "code": "3.1", "category": "VALUES", "programCLOCode": "V1", "description": "...", "teachingStrategies": ["Project"], "assessmentMethods": ["Project Report"] }
]

Some course specifications include a Teaching Mode table inside the course description (see example below). Instead of a single enum value for teaching mode, extract the table rows and return them as an array named "teachingModes".

If the document contains a table like:

No | Mode of Instruction | Contact Hours | Percentage
1. | Traditional classroom | 45 | 100

Then produce:

"teachingModes": [
  { "modeOfInstruction": "Traditional classroom", "contactHours": 45, "percentage": 100 }
]

Some course specifications also include an Assessment / Activities / Evaluation table with timing (when the activity occurs) and grade-weight percentage. Extract every row into "assessments".

If the document contains a table like:

No | Assessment Task | Timing | Percentage of Total Assessment
1. | Mid-Term Exam | Week 7 | 20%
2. | Quizzes | Throughout the term | 10%
3. | Final Exam | End of semester | 40%

Then produce:

"assessments": [
  { "title": "Mid-Term Exam", "type": "MID_TERM_EXAM", "timing": "Week 7", "percentage": 20, "duration": null, "totalMarks": null, "passMark": null, "numberOfVersions": 2, "difficulty": "BALANCED" },
  { "title": "Quizzes", "type": "QUIZ", "timing": "Throughout the term", "percentage": 10, "duration": null, "totalMarks": null, "passMark": null, "numberOfVersions": 2, "difficulty": "BALANCED" },
  { "title": "Final Exam", "type": "FINAL_EXAM", "timing": "End of semester", "percentage": 40, "duration": null, "totalMarks": null, "passMark": null, "numberOfVersions": 2, "difficulty": "BALANCED" }
]

Rules for assessment timing and percentage:
- "timing" is the schedule / when it happens (e.g. "Week 7", "End of semester", "Throughout the term"). Use null only if the document truly has no timing info.
- "percentage" is the grade weight toward the final grade as a number (e.g. 20 for 20%). Do NOT confuse this with totalMarks (exam point total) or teachingModes percentage.
- Prefer explicit Assessment / Evaluation / Activities tables when present. Also scan narrative course-description text for activity weights and timings.
- Keep "duration" as exam length in minutes when stated; keep "totalMarks" as point total when stated. These are separate from "percentage".

Rules for mainObjective:
- Extract the course main purpose / main objective / course objectives section (often labeled "Main Objective", "Course Objectives", "What is the main purpose for this course?", or Arabic equivalents).
- Return a single free-text string (preserve paragraphs). Use null only if the document has no such section.
- Do NOT copy the full course description into mainObjective when a distinct objectives section exists.

The JSON must follow this exact structure:
{
  "title": string,
  "code": string | null,
  "program": string | null,
  "description": string,
  "creditHours": number,
  "level": string | null,
  "teachingModes": [
    {
      "modeOfInstruction": string,
      "contactHours": number | null,
      "percentage": number | null
    }
  ],
  "totalContactHours": number,
  "lectureHours": number,
  "labHours": number,
  "prerequisites": string[],
  "coRequisites": string[],
  "mainObjective": string | null,
  "requiredFacilitiesAndEquipment": [
    {
      "item": string,
      "resources": string
    }
  ],
  "references": [
    {
      "type": "ESSENTIAL" | "SUPPORTIVE" | "ELECTRONIC" | "OTHER",
      "title": string,
      "authors": string | null,
      "publisher": string | null
    }
  ],
  "clos": [
    {
      "code": string,
      "category": "KNOWLEDGE" | "SKILLS" | "VALUES",
      "programCLOCode": string | null,
      "description": string,
      "teachingStrategies": string[],
      "assessmentMethods": string[]
    }
  ],
  "topics": [
    {
      "topicNumber": number,
      "title": string,
      "contactHours": number,
      "mappedClos": string[]
    }
  ],
  "assessments": [
    {
      "title": string,
      "type": "QUIZ" | "FINAL_EXAM" | "MID_TERM_EXAM" | "LAB" | "ASSIGNMENT" | "OTHER",
      "timing": string | null,
      "percentage": number | null,
      "duration": number | null,
      "totalMarks": number | null,
      "passMark": number | null,
      "numberOfVersions": number,
      "difficulty": "BEGINNER" | "EASY" | "BALANCED" | "MIXED" | "ADVANCED" | "EXPERT"
    }
  ]
}`;
