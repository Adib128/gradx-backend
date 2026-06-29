import z from 'zod';

export const TopicSchema = z.object({
  topicNumber: z.number().int().positive('Topic number must be greater than 0'),
  title: z.string().min(1, 'Topic title is required'),
  contactHours: z
    .number()
    .int()
    .positive('Contact hours must be greater than 0')
    .default(3),
  mappedClos: z.array(z.string()).default([]),
});
