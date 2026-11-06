const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * mobile-ui-and-themes.md §4.2: the screen option for a transcript option's label. An exact label
 * wins; a prefix (a label cut short on screen) counts only when one option alone has it. Anything
 * else is no match, never a guess.
 */
export function matchScreenOption<T extends { label: string }>(options: T[], label: string): T | undefined {
  const want = norm(label);
  const exact = options.find((o) => norm(o.label) === want);
  if (exact) return exact;
  const prefixed = options.filter((o) => norm(o.label).startsWith(want) || want.startsWith(norm(o.label)));
  return prefixed.length === 1 ? prefixed[0] : undefined;
}
