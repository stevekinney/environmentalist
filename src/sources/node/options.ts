import type { ConfigLoader } from '../../types.js';

/** Options shared by the Node source factories. */
export type NodeSourceOptions = {
  readonly envPrefix?: string;
  readonly root?: string;
  readonly stopAt?: string | readonly string[];
  readonly loader?: 'auto' | 'bun' | 'jiti' | ConfigLoader;
  readonly home?: string;
  readonly homeDirectory?: string;
};
