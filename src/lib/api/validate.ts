/**
 * Tiny hand-rolled validators for API request bodies.
 *
 * Each helper either returns a cleaned value or throws {@link ValidationError},
 * which routes catch and turn into a 400. They exist to replace the silent
 * coercion (`String(x).slice(...)`, `Number(x)`) that was scattered across
 * mutating routes — invalid input should be rejected, not quietly reshaped.
 */

/** Thrown by validators on bad input. Carries a stable machine-readable code. */
export class ValidationError extends Error {
  constructor(public code: string = "bad_request") {
    super(code);
    this.name = "ValidationError";
  }
}

/**
 * Validate a string. Trims, enforces `max` length and `required`.
 * Returns `undefined` for absent/empty optional values.
 */
export function str(
  v: unknown,
  opts: { max?: number; min?: number; required?: boolean } = {},
): string | undefined {
  const { max, min = 0, required = false } = opts;
  if (v === undefined || v === null) {
    if (required) throw new ValidationError();
    return undefined;
  }
  if (typeof v !== "string") throw new ValidationError();
  const s = v.trim();
  if (s.length === 0) {
    if (required) throw new ValidationError();
    return undefined;
  }
  if (s.length < min) throw new ValidationError();
  if (max !== undefined && s.length > max) throw new ValidationError();
  return s;
}

/**
 * Validate an integer (accepts numeric strings). Enforces `min`/`max` bounds.
 * Returns `undefined` for absent optional values; throws when required & absent.
 */
export function int(
  v: unknown,
  opts: { min?: number; max?: number; required?: boolean } = {},
): number | undefined {
  const { min, max, required = false } = opts;
  if (v === undefined || v === null || v === "") {
    if (required) throw new ValidationError();
    return undefined;
  }
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new ValidationError();
  if (min !== undefined && n < min) throw new ValidationError();
  if (max !== undefined && n > max) throw new ValidationError();
  return n;
}

/**
 * Validate that `v` is one of `allowed`. Returns `undefined` for absent optional
 * values; throws when required & absent or when the value isn't in the set.
 */
export function oneOf<T extends string>(
  v: unknown,
  allowed: readonly T[],
  opts: { required?: boolean } = {},
): T | undefined {
  const { required = false } = opts;
  if (v === undefined || v === null) {
    if (required) throw new ValidationError();
    return undefined;
  }
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    throw new ValidationError();
  }
  return v as T;
}
