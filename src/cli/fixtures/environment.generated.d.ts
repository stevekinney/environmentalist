export type FixtureEnvironment = {
  readonly mode: string;
  readonly anthropicApiKey: string;
  readonly server: {
    readonly port: number;
    readonly enabled: boolean;
  };
  readonly tags?: Array<string> | undefined;
};
