import { CLOSchemaDto } from 'src/course/dto/create-clo.dto';
import { ReferenceSchemaDto } from 'src/course/dto/create-reference.dto';

export type CollegeDocumentKind = 'LAB' | 'TUTORIAL';

/** Instructor-facing parameters for NCAAA-style lab / tutorial generation. */
export type CollegeDocumentParams = {
  documentNo: number;
  title: string;
  courseCode: string;
  courseName: string;
  semester: string;
  instructor: string;
  section: string;
  duration: string;
  relatedLecture: string;
  prerequisites: string;
  /** Lab: tools & environment. Tutorial: materials allowed. */
  toolsOrMaterials: string;
  totalMarks: number;
  guidedCount: number;
  taskOrProblemCount: number;
  questionCount: number;
  contentLanguage: 'ar' | 'en';
};

export type CollegeDocumentJob = {
  tenantId: number;
  userId?: number;
  topicId: number;
  courseId: number;
  kind: CollegeDocumentKind;
  topicTitle: string;
  topicNumber: number;
  courseTitle: string;
  courseDescription: string;
  clos: CLOSchemaDto[];
  targetedCloIds: string[];
  references: ReferenceSchemaDto[];
  /** Prefer slides deck; fall back to lecture notes. */
  sourceContent: unknown;
  sourceType: 'SLIDES' | 'LECTURE' | 'NONE';
  params: CollegeDocumentParams;
  generationPlanId?: number | null;
  generationPlanCode?: string | null;
  model?: string | null;
  maxTokens?: number | null;
};

export type CollegeDocumentProgress = {
  stage: string;
  percent: number;
  message: string;
  partial: Record<string, unknown>;
};
