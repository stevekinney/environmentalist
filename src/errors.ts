/**
 * Error thrown when Environmentalist cannot accept or resolve configuration.
 */
export class EnvironmentalistError extends Error {
  /** Structured details for callers that need more than the message. */
  readonly issues?: readonly unknown[];

  /**
   * Create an Environmentalist error.
   *
   * @param message - A human-readable explanation of the failure.
   * @param issues - Optional structured issue payload.
   */
  constructor(message: string, issues?: readonly unknown[]) {
    super(message);
    this.name = 'EnvironmentalistError';
    if (issues !== undefined) {
      this.issues = issues;
    }
  }
}
