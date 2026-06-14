export const EXTRACT_COURSE_PROMPT = `
You are an expert academic data extractor.
Extract the course specification data from this PDF and return ONLY a valid JSON object.
Do NOT include any markdown, explanation, or extra text — just raw JSON.

Make sure to map the relationship between topics and Course Learning Outcomes (CLOs) by populating the "mappedClos" array inside each topic with the matching CLO codes, corresponding to the CLO-Topic matrix found in the document.

The JSON must follow this exact structure:
{
  "title": string,
  "code": string | null,
  "program": string | null,
  "description": string,
  "creditHours": number,
  "level": string | null,
  "teachingMode": "TRADITIONAL" | "ONLINE" | "HYBRID" | "LAB",
  "totalContactHours": number,
  "lectureHours": number,
  "labHours": number,
  "prerequisites": string[],
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
