/**
 * Preserve a configuration object while documenting the strict usage pattern:
 * `defineConfig<Env>(config)` accepts `DeepPartial<CamelCasedPropertiesDeep<z.input<S>>>`.
 */
export function defineConfig<T>(config: T): T {
  return config;
}
