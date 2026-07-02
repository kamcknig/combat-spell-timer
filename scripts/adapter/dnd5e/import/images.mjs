import { MODULE_ID } from "../../../module.mjs";

const BASE = `modules/${MODULE_ID}/assets/icons`;

/**
 * Curated 30×30 icon per implemented feature, keyed by a stable internal feature key
 * (see featureKey() in builders.mjs). Add an entry as each feature's art is created.
 */
export const FEATURE_IMAGES = {
  "class:fighter":                             `${BASE}/fighter.webp`,
  "feat:second-wind":                          `${BASE}/second-wind.webp`,
  "feat:fighting-style-archery":               `${BASE}/fighting-style-archery.webp`,
  "feat:fighting-style-defense":               `${BASE}/fighting-style-defense.webp`,
  "feat:fighting-style-dueling":               `${BASE}/fighting-style-dueling.webp`,
  "feat:fighting-style-great-weapon-fighting": `${BASE}/fighting-style-great-weapon-fighting.webp`,
  "feat:fighting-style-protection":            `${BASE}/fighting-style-protection.webp`,
  "feat:fighting-style-interception":          `${BASE}/fighting-style-interception.webp`,
  "feat:fighting-style-thrown-weapon-fighting":`${BASE}/fighting-style-thrown-weapon-fighting.webp`,
  "feat:fighting-style-blind-fighting":        `${BASE}/fighting-style-blind-fighting.webp`,
};

/** Curated path for a key, else the provided dnd5e fallback icon. */
export function imageFor(key, fallback) { return FEATURE_IMAGES[key] ?? fallback; }
