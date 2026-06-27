export const EXTRACT_COURSE_PROMPT = `
You are an expert academic data extractor.
Extract the course specification data from this PDF and return ONLY a valid JSON object.
Do NOT include any markdown, explanation, or extra text — just raw JSON.

Make sure to map the relationship between topics and Course Learning Outcomes (CLOs) by populating the "mappedClos" array inside each topic with the matching CLO codes, corresponding to the CLO-Topic matrix found in the document.

Some course specifications include a Teaching Mode table inside the course description (see example below). Instead of a single enum value for teaching mode, extract the table rows and return them as an array named "teachingModes".

If the document contains a table like:

No | Mode of Instruction | Contact Hours | Percentage
1. | Traditional classroom | 45 | 100

Then produce:

"teachingModes": [
  { "modeOfInstruction": "Traditional classroom", "contactHours": 45, "percentage": 100 }
]

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
      "type": "QUIZ" | "FINAL_EXAM" | "MID_TERM_EXAM" | "LAB" | "OTHER",
      "duration": number | null,
      "totalMarks": number | null,
      "passMark": number | null,
      "numberOfVersions": number,
      "difficulty": "BEGINNER" | "EASY" | "BALANCED" | "MIXED" | "ADVANCED" | "EXPERT"
    }
  ]
}`;
