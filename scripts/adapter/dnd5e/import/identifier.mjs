/**
 * dnd5e identifier slug: lowercase, drop any parenthetical (edition suffix),
 * non-alphanumerics → "-", collapse repeats. Result matches ^[a-z0-9_-]+$.
 * "Fighter (2014)" → "fighter"; "Battle Master" → "battle-master".
 */
export function slugIdentifier(name) {
  return String(name ?? "")
    .split("(")[0].trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
