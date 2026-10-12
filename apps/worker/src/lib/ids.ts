/** Prefixed, URL-safe random identifiers (e.g. req_3f9c…). */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
