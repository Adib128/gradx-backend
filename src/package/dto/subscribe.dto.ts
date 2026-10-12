import { createZodDto } from 'nestjs-zod';
import z from 'zod';

export const subscribeSchema = z.object({
  planId: z.number().int().positive(),
  periodId: z.number().int().positive(),
});
export class SubscribeDto extends createZodDto(subscribeSchema) {}

export const renewSchema = z.object({
  periodId: z.number().int().positive(),
});
export class RenewDto extends createZodDto(renewSchema) {}
