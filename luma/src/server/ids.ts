/**
 * Row ids derived from a name someone typed.
 *
 * Providers, models and profiles all let a person name the thing and then need a
 * key for it, and all three arrived at the same rules independently: lowercase,
 * runs of anything unusable collapsed to a single hyphen, no hyphen on either
 * end. Three copies of that is three chances for two of them to drift, which
 * matters because an id is what every other row points at.
 *
 * The fallback exists because a name can be entirely punctuation or entirely
 * non-Latin, and an empty primary key is worse than an ugly one.
 */
export const slug = (value: string, fallbackPrefix?: string) =>
  value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") ||
  (fallbackPrefix ? `${fallbackPrefix}-${Date.now()}` : "");
