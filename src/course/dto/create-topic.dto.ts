import { createZodDto } from 'nestjs-zod';
import { TopicSchema } from '../schemas/topic.schema';

export class CreateTopicDto extends createZodDto(TopicSchema) {}
