/**
 * Feature keys whose feat item ships with a purely cosmetic, empty-changes
 * transfer effect — so the actor's Effects tab shows "you have this fighting
 * style" for as long as they have the feat, regardless of equipment. The
 * actual mechanical bonus (conditional on the specific weapon used in a given
 * attack) is applied separately, at roll time, by archery.mjs / dueling.mjs —
 * NOT by this effect, which never has any changes.
 */
export const COSMETIC_EFFECT_KEYS = new Set([
  "feat:fighting-style-archery",
  "feat:fighting-style-dueling",
  "feat:fighting-style-great-weapon-fighting",
  "feat:fighting-style-protection",
]);

/**
 * Build the `effects` array for a feature item: one empty-changes, always-on
 * transfer effect (same name/icon as the item) when the key is in
 * COSMETIC_EFFECT_KEYS, else none.
 * @param {string} key   featureKey("feat", name)
 * @param {{name: string, img: string}} item
 * @returns {object[]}
 */
export function buildFeatureEffects(key, { name, img }) {
  if (!COSMETIC_EFFECT_KEYS.has(key)) return [];
  return [{
    _id: foundry.utils.randomID(),
    name,
    img,
    transfer: true,
    disabled: false,
    changes: [],
  }];
}
