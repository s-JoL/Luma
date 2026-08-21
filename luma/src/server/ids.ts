/**
 * Row ids derived from a name someone typed.
 *
 * Providers and models all let a person name the thing and then need a
 * key for it, and both arrived at the same rules independently: lowercase,
 * runs of anything unusable collapsed to a single hyphen, no hyphen on either
 * end. Two copies of that is two chances for them to drift, which
 * matters because an id is what every other row points at.
 *
 * The fallback exists because a name can be entirely punctuation or entirely
 * non-Latin, and an empty primary key is worse than an ugly one.
 */
export const slug = (value: string, fallbackPrefix?: string) =>
  value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") ||
  (fallbackPrefix ? `${fallbackPrefix}-${Date.now()}` : "");
