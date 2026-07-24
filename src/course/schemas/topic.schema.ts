import z from 'zod';
import { ValidationMessageKey as V } from 'src/common/constants/validation-message';

export const TopicSchema = z.object({
  topicNumber: z.number().int().positive(V.TOPIC_NUMBER_INVALID),
  title: z.string().min(1, V.TOPIC_TITLE_REQUIRED),
  contactHours: z
    .number()
    .int()
    .positive(V.CONTACT_HOURS_INVALID)
    .default(3),
  mappedClos: z.array(z.string()).default([]),
});
