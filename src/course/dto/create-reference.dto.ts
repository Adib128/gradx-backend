import { createZodDto } from 'nestjs-zod';
import { ReferenceSchema } from '../schemas/reference.schema';

export class ReferenceSchemaDto extends createZodDto(ReferenceSchema) {}
