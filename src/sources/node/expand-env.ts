/**
 * A minimal, vendored port of `dotenv-expand`'s variable-substitution logic
 * (`${VAR}` / `$VAR`, with `-`/`:-`/`+`/`:+` default-value operators and
 * `\$`-escaping). Kept in-repo instead of as a dependency because upstream's
 * latest release bundles unrelated crypto/cipher primitives for a vault
 * feature this library never uses.
 */

const REFERENCE_PATTERN = /(?<!\\)\${([^{}]+)}|(?<!\\)\$([A-Za-z_][A-Za-z0-9_]*)/g;
const OPERATOR_PATTERN = /(:\+|\+|:-|-)/;

function resolveEscapeSequences(value: string): string {
  return value.replaceAll(/\\\$/g, '$');
}

// Matches upstream dotenv-expand: `String#split(null)` coerces the
// separator to the literal string "null", which is a no-op for any
// expression that doesn't contain that substring — it is not the same as
// splitting on ''.
function splitOnOperator(expression: string, splitter: string | null): string[] {
  return expression.split(splitter === null ? 'null' : splitter);
}

function resolveExpression(
  expression: string,
  environment: Readonly<Record<string, string | undefined>>,
): { key: string; resolved: string | undefined; defaultValue: string } {
  const operatorMatch = expression.match(OPERATOR_PATTERN);
  const splitter = operatorMatch ? operatorMatch[0] : null;
  const parts = splitOnOperator(expression, splitter);
  const key = parts.shift() ?? '';

  if (splitter === ':+' || splitter === '+') {
    return { key, resolved: undefined, defaultValue: environment[key] ? parts.join(splitter) : '' };
  }

  return { key, resolved: environment[key], defaultValue: parts.join(splitter ?? 'null') };
}

function expandValue(
  value: string,
  processEnv: Readonly<Record<string, string | undefined>>,
  runningParsed: Readonly<Record<string, string>>,
): string {
  const environment: Record<string, string | undefined> = { ...runningParsed, ...processEnv };

  let result = value;
  let match: RegExpExecArray | null;
  const seen = new Set<string>();

  REFERENCE_PATTERN.lastIndex = 0;
  while ((match = REFERENCE_PATTERN.exec(result)) !== null) {
    seen.add(result);

    const [template, bracedExpression, unbracedExpression] = match;
    const { key, resolved, defaultValue } = resolveExpression(
      bracedExpression ?? unbracedExpression ?? '',
      environment,
    );

    result =
      resolved && !seen.has(resolved)
        ? result.replace(template, resolved)
        : result.replace(template, defaultValue);

    if (result === runningParsed[key]) {
      break;
    }

    REFERENCE_PATTERN.lastIndex = 0;
  }

  return result;
}

/**
 * Expand `${VAR}`/`$VAR` references in `parsed` against `processEnv`,
 * mutating both `parsed` and `processEnv` in place, mirroring
 * `dotenv-expand`'s `expand()`.
 */
export function expandEnv(options: {
  parsed: Record<string, string>;
  processEnv: Record<string, string | undefined>;
}): void {
  const { parsed, processEnv } = options;
  const runningParsed: Record<string, string> = {};

  for (const key of Object.keys(parsed)) {
    let value = parsed[key] ?? '';

    if (processEnv[key] && processEnv[key] !== value) {
      value = processEnv[key];
    } else {
      value = expandValue(value, processEnv, runningParsed);
    }

    const resolved = resolveEscapeSequences(value);
    parsed[key] = resolved;
    runningParsed[key] = resolved;
  }

  for (const key of Object.keys(parsed)) {
    processEnv[key] = parsed[key];
  }
}
