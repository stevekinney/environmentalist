import { z } from 'zod';

/** Stable schema fixture used by the CLI and generated-type acceptance tests. */
export const schema = z.object({
  mode: z.string().default('development'),
  ANTHROPIC_API_KEY: z.string(),
  server: z.object({
    PORT: z.number(),
    enabled: z.boolean().default(true),
  }),
  tags: z.array(z.string()).optional(),
});
