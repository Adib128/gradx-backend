import { ContentType } from 'generated/prisma/browser';
import { CLOSchemaDto } from 'src/course/dto/create-clo.dto';
import { ReferenceSchemaDto } from 'src/course/dto/create-reference.dto';

export interface ContentGenerationJob {
  tenantId: number;
  topicId: number;
  contentId: number;
  type: ContentType;
  topicTitle: string;
  topicNumber: number;
  courseId: number;
  courseTitle: string;
  courseDescription: string;
  clos: CLOSchemaDto[];
  references: ReferenceSchemaDto[];
}
