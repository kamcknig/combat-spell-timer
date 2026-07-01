import { MODULE_ID } from "../../../module.mjs";

const BASE = `modules/${MODULE_ID}/assets/icons`;

/**
 * Curated 30×30 icon per implemented feature, keyed by a stable internal feature key
 * (see featureKey() in builders.mjs). Add an entry as each feature's art is created.
 */
export const FEATURE_IMAGES = {
  "class:fighter":               `${BASE}/fighter.webp`,
  "feat:second-wind":            `${BASE}/second-wind.webp`,
  "feat:fighting-style-archery": `${BASE}/fighting-style-archery.webp`,
  "feat:fighting-style-defense": `${BASE}/fighting-style-defense.webp`,
  "feat:fighting-style-dueling": `${BASE}/fighting-style-dueling.webp`,
};

/** Curated path for a key, else the provided dnd5e fallback icon. */
export function imageFor(key, fallback) { return FEATURE_IMAGES[key] ?? fallback; }
