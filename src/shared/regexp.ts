/** The text with every regular-expression metacharacter escaped, so it matches itself literally. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
