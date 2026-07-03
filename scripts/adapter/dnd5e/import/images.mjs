import { MODULE_ID } from "../../../module.mjs";

const BASE = `modules/${MODULE_ID}/assets/icons`;

/**
 * Curated 30×30 icon per implemented feature, keyed by a stable internal feature key
 * (see featureKey() in builders.mjs). Add an entry as each feature's art is created.
 */
export const FEATURE_IMAGES = {
  "class:fighter":                             `${BASE}/fighter.webp`,
  "feat:second-wind":                          `${BASE}/second-wind.webp`,
  "feat:action-surge":                         `${BASE}/action-surge.webp`,
  "feat:tactical-mind":                        `${BASE}/tactical-mind.webp`,
  "feat:fighting-style-archery":               `${BASE}/fighting-style-archery.webp`,
  "feat:fighting-style-defense":               `${BASE}/fighting-style-defense.webp`,
  "feat:fighting-style-dueling":               `${BASE}/fighting-style-dueling.webp`,
  "feat:fighting-style-great-weapon-fighting": `${BASE}/fighting-style-great-weapon-fighting.webp`,
  "feat:fighting-style-protection":            `${BASE}/fighting-style-protection.webp`,
  "feat:fighting-style-interception":          `${BASE}/fighting-style-interception.webp`,
  "feat:fighting-style-thrown-weapon-fighting":`${BASE}/fighting-style-thrown-weapon-fighting.webp`,
  "feat:fighting-style-unarmed-fighting":      `${BASE}/fighting-style-unarmed-fighting.webp`,
  "feat:fighting-style-blind-fighting":        `${BASE}/fighting-style-blind-fighting.webp`,
  "feat:weapon-mastery-cleave":                `${BASE}/weapon-mastery-cleave.webp`,
  "feat:weapon-mastery-graze":                 `${BASE}/weapon-mastery-graze.webp`,
  "feat:weapon-mastery-nick":                  `${BASE}/weapon-mastery-nick.webp`,
  "feat:weapon-mastery-push":                  `${BASE}/weapon-mastery-push.webp`,
  "feat:weapon-mastery-sap":                   `${BASE}/weapon-mastery-sap.webp`,
  "feat:weapon-mastery-slow":                  `${BASE}/weapon-mastery-slow.webp`,
  "feat:weapon-mastery-topple":                `${BASE}/weapon-mastery-topple.webp`,
  "feat:weapon-mastery-vex":                   `${BASE}/weapon-mastery-vex.webp`,
};

/** Curated path for a key, else the provided dnd5e fallback icon. */
export function imageFor(key, fallback) { return FEATURE_IMAGES[key] ?? fallback; }
