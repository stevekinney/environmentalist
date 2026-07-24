import { describe, expect, it } from 'bun:test';
import { expectTypeOf } from 'expect-type';
import { z } from 'zod';

import {
  SCHEMA,
  SOURCES,
  type CamelCase,
  type CamelCasedPropertiesDeep,
  type Environment,
} from './types.js';

describe('shared type contracts', () => {
  it('exports distinct provenance and schema symbols', () => {
    expect(SOURCES).not.toBe(SCHEMA);
    expect(typeof SOURCES).toBe('symbol');
    expect(typeof SCHEMA).toBe('symbol');
  });

  it('maps representative schema keys to canonical environment properties', () => {
    const schema = z.object({
      ANTHROPIC_API_KEY: z.string(),
      AWS_REGION: z.string(),
      s3Bucket: z.string(),
      oauth2Token: z.string(),
      'server-port': z.number(),
    });

    type Result = Environment<typeof schema>;
    expectTypeOf<Result>().toHaveProperty('anthropicApiKey').toEqualTypeOf<string>();
    expectTypeOf<Result>().toHaveProperty('awsRegion').toEqualTypeOf<string>();
    expectTypeOf<Result>().toHaveProperty('s3Bucket').toEqualTypeOf<string>();
    expectTypeOf<Result>().toHaveProperty('oauth2Token').toEqualTypeOf<string>();
    expectTypeOf<Result>().toHaveProperty('serverPort').toEqualTypeOf<number>();
    expectTypeOf<CamelCase<'SERVER.PORT'>>().toEqualTypeOf<'server.port'>();
  });

  it('keeps adversarial key boundaries aligned with the runtime transform', () => {
    expectTypeOf<CamelCase<'A1B2'>>().toEqualTypeOf<'a1B2'>();
    expectTypeOf<CamelCase<'HTTP2Server'>>().toEqualTypeOf<'http2Server'>();
    expectTypeOf<CamelCase<'XMLHttpRequest'>>().toEqualTypeOf<'xmlHttpRequest'>();
    expectTypeOf<CamelCase<'2FA_CODE'>>().toEqualTypeOf<'2FaCode'>();
    expectTypeOf<CamelCase<'server.2FA_PORT'>>().toEqualTypeOf<'server.2FaPort'>();
  });

  it('uses schema output types so defaulted fields are required', () => {
    const schema = z.object({
      PORT: z.number().default(3000),
      SERVER: z.object({ PORT: z.number() }),
    });

    type Result = Environment<typeof schema>;
    expectTypeOf<Result['port']>().toEqualTypeOf<number>();
    expectTypeOf<Result['server']>().toEqualTypeOf<{ port: number }>();
  });

  it('deeply maps records and objects nested in arrays', () => {
    type Result = CamelCasedPropertiesDeep<{
      SERVER: { PORT: number };
      ITEMS: Array<{ ITEM_ID: string }>;
    }>;

    expectTypeOf<Result>().toEqualTypeOf<{
      server: { port: number };
      items: Array<{ itemId: string }>;
    }>();
  });
});
