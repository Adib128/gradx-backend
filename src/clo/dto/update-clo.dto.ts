import { PartialType } from '@nestjs/swagger';
import { CreateCloDto } from './create-clo.dto';

export class UpdateCloDto extends PartialType(CreateCloDto) {}
