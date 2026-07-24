import { describe, it } from 'bun:test';
import { expectTypeOf } from 'expect-type';
import type { Environment } from '../../types.js';
import { SCHEMA, SOURCES } from '../../types.js';
import { schema } from './environment.js';
import type { FixtureEnvironment } from './environment.generated.js';

type PublicEnvironment = Omit<Environment<typeof schema>, typeof SCHEMA | typeof SOURCES>;

describe('checked-in generated environment type', () => {
  it('is mutually assignable with the library environment output', () => {
    expectTypeOf<FixtureEnvironment>().toMatchTypeOf<PublicEnvironment>();
    expectTypeOf<PublicEnvironment>().toMatchTypeOf<FixtureEnvironment>();
  });
});
