/**
 * Feature keys whose feat item ships with its own limited-use pool
 * (`system.uses`), distinct from a class-wide resource pool tracked on a
 * different item (e.g. Channel Divinity, read directly off that item by
 * path-to-the-grave.mjs). Keyed by featureKey, then by edition ("2014"/"2024")
 * — Second Wind's uses genuinely differ by edition, verified against
 * ddb-importer's own `SecondWind` enricher (dist/main.mjs): 2014 gets no
 * override (1 use, recovered on a short or long rest — dnd5e's Long Rest
 * recoverPeriods already includes "sr", so a single {period:"sr"} entry
 * covers both); 2024's `get override()` pushes a SECOND uses count (2 total)
 * with a two-tier recovery a flat DDB `limitedUse.maxUses`/`resetType` field
 * doesn't capture on its own: a Long Rest fully restores both uses
 * (recoverAll), but a Short Rest restores only ONE (`type:"formula",
 * formula:"1"`) — not both. Raw DDB export data (`actions.class[]`) shows
 * this as maxUses:2/resetType:2 ("Long Rest"), which alone would miss the
 * short-rest partial-recovery rule; ddb-importer's enricher is the actual
 * source of truth per this module's own convention (see CLAUDE.md).
 */
export const FEATURE_USES_CONFIG = {
  "feat:second-wind": {
    "2014": { max: "1", recovery: [{ period: "sr", type: "recoverAll" }] },
    "2024": {
      max: "2",
      recovery: [
        { period: "lr", type: "recoverAll" },
        { period: "sr", type: "formula", formula: "1" },
      ],
    },
  },
};

/**
 * The character's actual current consumption of a named feature, from DDB's
 * own resolved-action data (`data.actions.class[].limitedUse.numberUsed`),
 * matched by name. Mirrors the existing precedent in buildClassItem
 * (`ddbClass.hitDiceUsed` → `system.hd.spent`) — import the character's real
 * current state rather than always assuming full uses.
 * @param {object[]} actions  ddbData.actions?.class ?? []
 * @param {string} name       the feature's DDB name (e.g. "Second Wind")
 * @returns {number}
 */
function numberUsedFrom(actions, name) {
  const match = (actions ?? []).find((a) => (a?.name ?? "").toLowerCase() === (name ?? "").toLowerCase());
  return Number(match?.limitedUse?.numberUsed) || 0;
}

/**
 * Build the `system.uses` override for a feature item, or the schema's own
 * default when the key (or edition) has no registered override.
 * @param {string} key    featureKey("feat", name)
 * @param {string} rules  the item's own edition, "2014" | "2024" (ctx.rules —
 *   NOT the world's active rules-version setting, which can differ; see
 *   edition-mismatch.mjs)
 * @param {object} [source]
 * @param {object[]} [source.actions]  ddbData.actions?.class ?? [], for reading current spent
 * @param {string} [source.name]       the feature's DDB name, for matching into `actions`
 * @returns {{spent: number, max: string, recovery: object[]}}
 */
export function buildFeatureUses(key, rules, { actions, name } = {}) {
  const config = FEATURE_USES_CONFIG[key]?.[rules];
  if (!config) return { spent: 0, max: "", recovery: [] };
  return { ...config, spent: numberUsedFrom(actions, name) };
}
