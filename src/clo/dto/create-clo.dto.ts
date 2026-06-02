import { createZodDto } from 'nestjs-zod';
import { CloSchema } from '../schemas/clo.schema';

export class CreateCloDto extends createZodDto(CloSchema) {}
