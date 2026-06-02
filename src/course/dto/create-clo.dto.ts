import { createZodDto } from 'nestjs-zod';
import { CloSchema } from 'src/clo/schemas/clo.schema';

export class CLOSchemaDto extends createZodDto(CloSchema) {}
