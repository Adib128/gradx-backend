export const EXTRACT_COURSE_PROMPT = `
You are an expert academic data extractor.
Extract the course specification data from this document and return ONLY a valid JSON object.
Do NOT include any markdown, explanation, or extra text — just raw JSON.

Document text notes:
- Word tables are given one row per line as "| cell | cell | ... |"; "<br>" separates paragraphs inside the same cell.
- Checkboxes appear as ☐ (unchecked) and ☒ / ☑ / ✓ / ✔ (checked).
- Values such as "Pick Revision Date.", "Course Specification Version Number", "( ……… )" or "Click or tap here to enter text." are unfilled template placeholders → return null.
- Copy only text that is actually in the document. Never write, complete, reword or summarize text yourself: if a value is only partly visible or unreadable, return just the readable part as printed (or null). Do not mix text from neighbouring columns or sections into a value.
- Reviewer annotations (red or coloured notes, remarks written over the page, e.g. "Course Policies — …", "Academic Integrity and AI Use — …", Arabic comments) are NOT course data: never output their text in any field and never create items from them.
- An item that is partly hidden behind such an annotation still counts: output it with only its own text (e.g. a reference card labelled "OTHER" whose title is still readable under the note), without any words from the annotation.
- A dash "—" / "-" shown as a value means empty → null.

Rules for the general information (cover page / header table):
- "code": copy the Course Code EXACTLY as printed, character for character, including every suffix, dash and digit (e.g. "329CSS-3" must stay "329CSS-3", never "329CSS"). Do not add or remove spaces.
- "program", "department", "college", "institution": copy the values after "Program:", "Department:", "College:", "Institution:" (Arabic: البرنامج، القسم، الكلية، المؤسسة).
- "version": value after "Version:" (e.g. "2", "V2.0"); "lastRevisionDate": value after "Last Revision Date:" exactly as printed (e.g. "9-10-2023"). Both null when missing or placeholder.

Rules for "1. Course Identification":
- "creditHoursDetail": the credit hours exactly as printed, keeping any breakdown, e.g. "3(2,2,1)" or "3 (2,1,0)". "creditHours" is only the leading total number (e.g. 3).
- "courseTypeScope" (Course type A): the ONE checked option among University / College / Department / Track / Others → "UNIVERSITY" | "COLLEGE" | "DEPARTMENT" | "TRACK" | "OTHERS". If "Others" is checked, put its text in "courseTypeOther".
- "courseRequirement" (Course type B): the checked option → "REQUIRED" | "ELECTIVE".
- Use null when no option is checked. Never guess from unchecked boxes.

Rules for "3. Contact Hours" table (Activity | Contact Hours):
- "lectureHours" = Lectures, "labHours" = Laboratory/Studio, "fieldHours" = Field, "tutorialHours" = Tutorial, "otherContactHours" = Others (specify) with its specified name in "otherContactHoursLabel", "totalContactHours" = Total.
- Empty cells → null. Do not use the Teaching Mode table or the Course Content topic hours for these fields.

Rules for the "Course Content" table (List of Topics | Contact Hours):
- Every topic row goes into "topics" with its own contact hours.
- "topicsTotalHours" = the number in that table's "Total" row exactly as printed (do NOT compute it yourself); null when the table has no Total row.

Rules for CLO "teachingStrategies" and "assessmentMethods":
- Read them ONLY from the "Teaching Strategies" and "Assessment Methods" columns of the CLO table row of that CLO. Never move assessment methods into teaching strategies or vice versa.
- Return one array item per strategy/method, copied completely and verbatim (keep labels like "TS:1-"). Items separated by "<br>", new lines, bullets or numbering are separate items. Do not truncate or summarize.
- When a strategy cell is shared (merged) by several CLOs, repeat the same strategies for each of those CLOs.

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

Some course specifications also include an Assessment / Activities / Evaluation table with grade-weight percentage. Extract every row into "assessments".

If the document contains a table like:

No | Assessment Activities | Assessment timing (in week no) | Percentage of Total Assessment Score
1. | Mid-Term Exam | 7th week | 20%
2. | Quizzes | 4, 6 and 10th | 10%
3. | Final Exam | 17 or 18 week | 40%
4. | Total |  | 70%

Then produce:

"assessments": [
  { "title": "Mid-Term Exam", "type": "MID_TERM_EXAM", "percentage": 20, "timing": "7th week", "duration": null, "totalMarks": null, "passMark": null, "numberOfVersions": 2, "difficulty": "BALANCED" },
  { "title": "Quizzes", "type": "QUIZ", "percentage": 10, "timing": "4, 6 and 10th", "duration": null, "totalMarks": null, "passMark": null, "numberOfVersions": 2, "difficulty": "BALANCED" },
  { "title": "Final Exam", "type": "FINAL_EXAM", "percentage": 40, "timing": "17 or 18 week", "duration": null, "totalMarks": null, "passMark": null, "numberOfVersions": 2, "difficulty": "BALANCED" }
],
"assessmentsTotalPercentage": 70

Rules for the "Students Assessment Activities" table (No | Assessment Activities | Assessment timing (in week no) | Percentage of Total Assessment Score):
- One "assessments" item per activity row, "title" copied exactly (e.g. "Project, presentation and Quiz").
- "timing" = the "Assessment timing (in week no)" cell copied verbatim (e.g. "4, 6 and 10th", "7th week", "1-15 week", "17 or 18 week"); null when empty.
- The "Total" row is NOT an assessment: put its percentage in "assessmentsTotalPercentage" exactly as printed (e.g. 100) and do not add it to "assessments".

Rules for assessment percentage:
- "percentage" is the grade weight toward the final grade as a number (e.g. 20 for 20%). Do NOT confuse this with totalMarks (exam point total) or teachingModes percentage.
- Prefer explicit Assessment / Evaluation / Activities tables when present. Also scan narrative course-description text for activity weights.
- Keep "duration" as exam length in minutes when stated; keep "totalMarks" as point total when stated. These are separate from "percentage".

Rules for "references":
- One item per reference line of the "References and Learning Resources" table, in document order; "type" from the row label (Essential References → ESSENTIAL, Supportive References → SUPPORTIVE, Electronic Materials → ELECTRONIC, Other Learning Materials → OTHER).
- Lines starting with "Note:" and empty rows are NOT references.
Rules for topic "mappedClos":
- Fill them ONLY from an explicit CLO–topic mapping/matrix in the document. If the document has no such matrix, return [] for every topic. Never guess.

Rules for "Assessment of Course Quality" table (Assessment Areas/Issues | Assessor | Assessment Methods):
- One "courseQualityAssessment" item per row: "area" = Assessment Areas/Issues, "assessor" = Assessor, "methods" = Assessment Methods, each copied verbatim.
- Skip the header row, rows whose Assessor and Assessment Methods are both empty, and template guidance text (e.g. "teaching strategies, assessment methods, textbooks, instructor, etc.").
- The legend lines below the table ("Assessor (Students, Faculty, ...)", "Assessment Methods (Direct, Indirect)") are NOT rows.

Rules for "Specification Approval Data" (a.k.a. "Specification Approval"):
- "approvalCouncil" = COUNCIL / COMMITTEE value, "approvalReferenceNo" = REFERENCE NO. value, "approvalDate" = DATE value exactly as printed (e.g. "12/10/2023"). Null when empty or placeholder.

Rules for mainObjective:
- Extract the course main purpose / main objective / course objectives section (often labeled "Main Objective", "Course Objectives", "What is the main purpose for this course?", or Arabic equivalents).
- Return a single free-text string (preserve paragraphs). Use null only if the document has no such section.
- Do NOT copy the full course description into mainObjective when a distinct objectives section exists.

The JSON must follow this exact structure:
{
  "title": string,
  "code": string | null,
  "program": string | null,
  "department": string | null,
  "college": string | null,
  "institution": string | null,
  "version": string | null,
  "lastRevisionDate": string | null,
  "description": string,
  "creditHours": number,
  "creditHoursDetail": string | null,
  "courseTypeScope": "UNIVERSITY" | "COLLEGE" | "DEPARTMENT" | "TRACK" | "OTHERS" | null,
  "courseTypeOther": string | null,
  "courseRequirement": "REQUIRED" | "ELECTIVE" | null,
  "level": string | null,
  "teachingModes": [
    {
      "modeOfInstruction": string,
      "contactHours": number | null,
      "percentage": number | null
    }
  ],
  "totalContactHours": number | null,
  "lectureHours": number | null,
  "labHours": number | null,
  "fieldHours": number | null,
  "tutorialHours": number | null,
  "otherContactHours": number | null,
  "otherContactHoursLabel": string | null,
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
  "topicsTotalHours": number | null,
  "assessments": [
    {
      "title": string,
      "type": "QUIZ" | "FINAL_EXAM" | "MID_TERM_EXAM" | "LAB" | "ASSIGNMENT" | "OTHER",
      "percentage": number | null,
      "timing": string | null,
      "duration": number | null,
      "totalMarks": number | null,
      "passMark": number | null,
      "numberOfVersions": number,
      "difficulty": "BEGINNER" | "EASY" | "BALANCED" | "MIXED" | "ADVANCED" | "EXPERT"
    }
  ],
  "assessmentsTotalPercentage": number | null,
  "courseQualityAssessment": [
    {
      "area": string,
      "assessor": string | null,
      "methods": string | null
    }
  ],
  "approvalCouncil": string | null,
  "approvalReferenceNo": string | null,
  "approvalDate": string | null
}`;
