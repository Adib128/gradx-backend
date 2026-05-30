import z from 'zod';

export const prismaEnumToZod = <T extends string>(
  prismaEnum: Record<string, T>,
) => {
  const values = Object.values(prismaEnum) as [T, ...T[]];
  return z.enum(values);
};
