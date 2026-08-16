import { CLOSchemaDto } from 'src/course/dto/create-clo.dto';
import { ReferenceSchemaDto } from 'src/course/dto/create-reference.dto';

export type GeneratedContentType = 'LECTURE' | 'SLIDES' | 'QUIZ' | 'LAB';

export type CourseNoteType =
  | 'Complete Topic Note'
  | 'Full Lecture Note'
  | 'Study Guide'
  | 'Instructor Guide'
  | 'Revision Notes'
  | 'Reading Material';

export type ContentDepth =
  | 'Undergraduate'
  | 'Introductory'
  | 'Advanced Undergraduate'
  | 'Graduate'
  | 'Professional'
  | 'Expert';

export type AudienceType =
  | 'Undergraduate'
  | 'Freshman'
  | 'Graduate'
  | 'PhD'
  | 'Professional'
  | 'Executive';

export type BloomTaxonomyLevel =
  | '1 Remember'
  | '2 Understand'
  | '3 Apply'
  | '4 Analyze'
  | '5 Evaluate'
  | '6 Create';

export type LearningComponent =
  | 'Learning Objectives'
  | 'Introduction'
  | 'Detailed Explanation'
  | 'Key Concepts'
  | 'Examples'
  | 'Case Study'
  | 'Summary'
  | 'References'
  | 'Self-Assessment'
  | 'Activities'
  | 'Reflection Questions';

export type ExampleLevel =
  | 'Academic'
  | 'Industry'
  | 'Research'
  | 'Local Context'
  | 'International Context';

export type VisualType =
  | 'Concept Diagrams'
  | 'Tables'
  | 'Process Flow'
  | 'Comparison Charts'
  | 'Real-world Visuals';

export type AssessmentIntegration =
  | 'Quiz Questions'
  | 'MCQs'
  | 'Short Answers'
  | 'Assignment Tasks'
  | 'Discussion Questions'
  | 'Exam Questions';

export type ContentLength = '2 pages' | '5 pages' | '10 pages' | '20 pages';
export type SlidesLength =
  | '8 slides'
  | '12 slides'
  | '16 slides'
  | '20 slides'
  | '24 slides';
export type DifficultyLevel = 'Easy' | 'Medium' | 'Hard';
export type AIQualityMode =
  | 'Academic Quality'
  | 'Fast'
  | 'Balanced'
  | 'Publication Quality';

export type HumanReviewCheck =
  | 'Fact Checking'
  | 'Consistency Check'
  | 'CLO Alignment Check'
  | 'Bloom Verification'
  | 'Detect AI Hallucinations'
  | 'Validate Definitions'
  | 'Verify References'
  | 'Academic Quality Score';

export interface ContentGenerationJob {
  tenantId: number;
  topicId: number;
  contentId: number;
  type: GeneratedContentType;
  topicTitle: string;
  topicNumber: number;
  courseId: number;
  courseTitle: string;
  courseDescription: string;
  clos: CLOSchemaDto[];
  references: ReferenceSchemaDto[];
  sourceLectureContentId?: number;
  sourceLectureContent?: unknown;
  courseNoteType: CourseNoteType;
  contentDepth: ContentDepth;
  audience: AudienceType;
  targetedCloIds: string[];
  bloomsTaxonomyLevels: BloomTaxonomyLevel[];
  learningComponents: LearningComponent[];
  exampleLevels: ExampleLevel[];
  visuals: VisualType[];
  assessmentIntegrations: AssessmentIntegration[];
  length: ContentLength;
  /** Target number of slides for SLIDES generation (e.g. "16 slides"). */
  slidesLength?: SlidesLength | string;
  difficulty: DifficultyLevel;
  aiQualityMode: AIQualityMode;
  humanReviewChecks: HumanReviewCheck[];
  /** Detected from course/topic text; drives generation language. */
  contentLanguage?: 'ar' | 'en';
  /**
   * When true, include attached reference document text for the indices listed
   * in `referenceDocumentIndices`. When false/omitted, bibliographic citations only.
   */
  useReferenceDocuments?: boolean;
  /** Indices into the course `references` array whose extracted text may be used. */
  referenceDocumentIndices?: number[];
}
