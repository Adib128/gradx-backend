import z from 'zod';

export const TopicSchema = z.object({
  topicNumber: z.number().int().positive(),
  title: z.string().min(1),
  contactHours: z.number().int().positive().default(3),
  mappedClos: z.array(z.string()).default([]),
});
