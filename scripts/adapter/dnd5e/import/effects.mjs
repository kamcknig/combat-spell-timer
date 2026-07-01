/**
 * Hard-coded passive ActiveEffect `changes`, per imported feature, keyed by the same
 * featureKey() used by images.mjs. Verified against dnd5e's own classfeatures
 * compendium item ("Fighting Style: Archery") rather than ddb-importer, which has no
 * enricher for this feature — it's a base-rules bonus, not DDB-specific automation.
 */
export const FEATURE_EFFECTS = {
  "feat:fighting-style-archery": [
    { key: "system.bonuses.rwak.attack", mode: CONST.ACTIVE_EFFECT_MODES.ADD, value: "+2", priority: 20 },
  ],
  "feat:fighting-style-defense": [
    { key: "system.attributes.ac.bonus", mode: CONST.ACTIVE_EFFECT_MODES.ADD, value: "+1", priority: 20 },
  ],
};

/**
 * Build the `effects` array for a feature item: one always-on transfer effect (same
 * name/icon as the item) when the key is mapped, else none.
 * @param {string} key   featureKey("feat", name)
 * @param {{name: string, img: string}} item
 * @returns {object[]}
 */
export function buildFeatureEffects(key, { name, img }) {
  const changes = FEATURE_EFFECTS[key];
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
