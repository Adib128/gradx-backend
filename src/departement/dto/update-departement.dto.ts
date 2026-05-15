import { createZodDto } from 'nestjs-zod';
import { createDepartementSchema } from './create-departement.dto';

export const UpdateDepartmentSchema = createDepartementSchema.partial();

export class UpdateDepartementDto extends createZodDto(
  UpdateDepartmentSchema,
) {}
