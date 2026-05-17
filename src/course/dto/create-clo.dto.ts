import { createZodDto } from 'nestjs-zod';
import { CLOSchema } from '../schemas/clo.schema';

export class CLOSchemaDto extends createZodDto(CLOSchema) {}
