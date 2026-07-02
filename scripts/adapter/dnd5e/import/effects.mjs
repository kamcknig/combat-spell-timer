/**
 * Feature keys whose feat item ships with a standing, `transfer: true`
 * ActiveEffect baked directly onto the item — active for as long as the actor
 * has the feat, regardless of equipment. Keyed by the effect's `changes`
 * array: an empty array is a purely cosmetic marker (the actor's Effects tab
 * shows "you have this fighting style," but the actual mechanical bonus, when
 * one exists, is conditional on the specific weapon/armor used and is applied
 * separately at roll time or by a dynamic sync hook — see archery.mjs,
 * dueling.mjs, great-weapon-fighting.mjs, defense.mjs). A non-empty array is a
 * real, unconditional bonus with no such gating — currently only Blind
 * Fighting's blindsight grant.
 */
export const FEATURE_EFFECT_CHANGES = {
  "feat:fighting-style-archery": [],
  "feat:fighting-style-dueling": [],
  "feat:fighting-style-great-weapon-fighting": [],
  "feat:fighting-style-protection": [],
  "feat:fighting-style-interception": [],
  "feat:fighting-style-thrown-weapon-fighting": [],
  "feat:fighting-style-unarmed-fighting": [],
  "feat:fighting-style-blind-fighting": [
    {
      key: "system.attributes.senses.blindsight",
      mode: CONST.ACTIVE_EFFECT_MODES.ADD,
      value: "10",
      priority: 20,
    },
  ],
};

/**
 * Build the `effects` array for a feature item: one `transfer: true` effect
 * (same name/icon as the item) carrying `FEATURE_EFFECT_CHANGES[key]` when the
 * key is registered, else none.
 * @param {string} key   featureKey("feat", name)
 * @param {{name: string, img: string}} item
 * @returns {object[]}
 */
export function buildFeatureEffects(key, { name, img }) {
  const changes = FEATURE_EFFECT_CHANGES[key];
  if (!changes) return [];
  return [{
    _id: foundry.utils.randomID(),
    name,
    img,
    transfer: true,
    disabled: false,
    changes,
  }];
}
