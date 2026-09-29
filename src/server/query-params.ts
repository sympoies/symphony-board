// Scalar URL query parsing shared by operational read APIs.

export function parsePositiveInt(value: string | null, name: string): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function parseNonNegativeNumber(value: string | null, name: string): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
}

export function parseBoolean(value: string | null): boolean {
  if (value == null || value === "") return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}
