import { dbg } from "../../../utils/debug.mjs";
import { filterByLevel } from "./level-check.mjs";
import {
  buildClassItem, buildSubclassItem, buildFeatureItem,
  buildChoiceFeatureItems, CHOICE_FEATURE_NAMES,
} from "./builders.mjs";
import { classEditionRules, cleanDdbName } from "./edition.mjs";
import { slugIdentifier } from "./identifier.mjs";
import { buildWeaponMasteryTraitUpdate, buildWeaponMasteryFeatureItems } from "./weapon-mastery.mjs";

/**
 * Parse cached DDB `.data` into dnd5e class/subclass/feature creation data.
 * Features-only — ignores inventory, spells, race, feats, background — plus
 * the actor-level chosen Weapon Mastery weapon types, if any.
 * @param {Actor} _actor  (unused for bulk import; level comes from the DDB class level)
 * @param {object} ddbData
 * @returns {Promise<{items: object[], actorUpdate: (object|undefined)}>}
 */
export async function parseImportedFeatures(_actor, ddbData) {
  const items = [];
  const actions = ddbData?.actions?.class ?? [];   // current per-feature usage (numberUsed), for buildFeatureUses
  for (const ddbClass of ddbData?.classes ?? []) {
    const def = ddbClass?.definition ?? {};
    const rules = classEditionRules(def.id);
    const classId = foundry.utils.randomID();
    const ctx = {
      className: cleanDdbName(def.name),
      classIdentifier: slugIdentifier(def.name),
      rules,
      classId,
      classLevel: ddbClass.level,   // for {{classlevel}} substitution in feature text
      actions,
    };

    items.push(buildClassItem(ddbClass, { id: classId }));
    const sub = buildSubclassItem(ddbClass);
    if (sub) items.push(sub);

    const { kept, skipped } = filterByLevel(ddbClass.classFeatures, ddbClass.level);
    dbg("ddb:parse", "class features by level", {
      class: ctx.className, level: ddbClass.level,
      kept: kept.map((f) => f?.definition?.name),
      skipped: skipped.map((f) => f?.definition?.name),
    });
    // 2014's Extra Attack is represented as multiple classFeatures entries
    // sharing the exact name "Extra Attack" (one per tier: 5/11/20), each
    // with its own tier-specific description. Collapse to the single
    // highest-tier entry applicable at the current level so only one item
    // (with the correct current description) is created — 2024 names each
    // tier differently ("Extra Attack" / "Two Extra Attacks" / "Three Extra
    // Attacks") so this never collapses more than one entry there.
    const extraAttackTiers = kept.filter((f) => f?.definition?.name === "Extra Attack");
    if (extraAttackTiers.length) {
      const best = extraAttackTiers.reduce((a, b) =>
        (b.definition.requiredLevel ?? 0) > (a.definition.requiredLevel ?? 0) ? b : a
      );
      dbg("ddb:parse", "extra attack tiers collapsed", {
        tiers: extraAttackTiers.map((f) => f.definition.requiredLevel),
        chosen: best.definition.requiredLevel,
      });
      items.push(buildFeatureItem(best.definition, ctx));
    }

    for (const f of kept) {
      const fdef = f?.definition;
      if (!fdef) continue;
      if (fdef.name === "Extra Attack") continue; // handled above, collapsed to one item
      if (CHOICE_FEATURE_NAMES.has(fdef.name)) {
        const options = buildChoiceFeatureItems(fdef, ddbData, ctx);
        dbg("ddb:parse", "choice feature resolved", {
          feature: fdef.name, options: options.map((o) => o.name),
        });
        items.push(...options);   // drop the generic parent (DISCARD_FEATURE_AFTER_CHOICES)
        continue;
      }
      if (fdef.name === "Weapon Mastery") {
        // One feat item per chosen weapon type ("Weapon Mastery: Dart Vex", etc.),
        // covering all 8 properties including the cosmetic ones — see
        // weapon-mastery.mjs#buildWeaponMasteryFeatureItems. Drops the generic
        // parent feature (no standalone item for "Weapon Mastery" itself), same
        // "pick one, discard the container" shape as CHOICE_FEATURE_NAMES above.
        const masteryItems = buildWeaponMasteryFeatureItems(ddbData, ctx);
        dbg("ddb:parse", "weapon mastery choices resolved", { items: masteryItems.map((i) => i.name) });
        items.push(...masteryItems);
        continue;
      }
      items.push(buildFeatureItem(fdef, ctx));
    }
  }
  const masteryUpdate = buildWeaponMasteryTraitUpdate(ddbData);
  dbg("ddb:parse", "built items", { count: items.length, mastery: !!masteryUpdate });
  return { items, actorUpdate: masteryUpdate ?? undefined };
}
