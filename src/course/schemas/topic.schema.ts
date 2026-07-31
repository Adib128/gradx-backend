import z from 'zod';
import { ValidationMessageKey as V } from 'src/common/constants/validation-message';

const normalizeContactHours = (value: unknown) => {
  if (value === null || value === undefined || value === '') return 3;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) return 3;
  return Math.round(numberValue);
};

const normalizeTopicNumber = (value: unknown) => {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0
    ? Math.round(numberValue)
    : undefined;
};

export const TopicSchema = z.object({
  topicNumber: z.preprocess(
    normalizeTopicNumber,
    z.number().int().positive(V.TOPIC_NUMBER_INVALID),
  ),
  title: z.preprocess(
    (value) => String(value ?? '').trim(),
    z.string().min(1, V.TOPIC_TITLE_REQUIRED),
  ),
  contactHours: z.preprocess(
    normalizeContactHours,
    z.number().int().positive(V.CONTACT_HOURS_INVALID).default(3),
  ),
  mappedClos: z.array(z.string()).default([]),
});
