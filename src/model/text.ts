export const PROVIDER_BODY_MAX_CHARS = 65_536;
export const PROVIDER_BODY_TRUNCATED_SUFFIX =
  "\n\n[Body truncated by symphony-board; open the provider link for the full text.]";

export function cleanProviderBody(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  if (text.length <= PROVIDER_BODY_MAX_CHARS) return text;
  const room = Math.max(0, PROVIDER_BODY_MAX_CHARS - PROVIDER_BODY_TRUNCATED_SUFFIX.length);
  return `${text.slice(0, room).trimEnd()}${PROVIDER_BODY_TRUNCATED_SUFFIX}`;
}
