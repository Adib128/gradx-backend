import { createZodDto } from 'nestjs-zod';
import { TopicSchema } from '../schemas/topic.schema';

const updateTopicSchema = TopicSchema.partial();

export class UpdateTopicDto extends createZodDto(updateTopicSchema) {}
