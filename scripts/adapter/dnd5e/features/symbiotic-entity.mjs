import { dbg } from "../../../utils/debug.mjs";

/**
 * dnd5e Circle of Spores "Symbiotic Entity" feature descriptor.
 *
 * NOTE: Symbiotic Entity / Halo of Spores are Circle of Spores DRUID features;
 * the branch/folder naming uses "cleric". Detection is class-agnostic (by item
 * name/identifier), so this works regardless of how the feature is granted.
 *
 * Scope (per request): apply a 10-minute (100-round) self buff that
 *  - shows a token condition icon (the AE status), and
 *  - adds +1d6 necrotic to melee weapon attack rolls, and
 *  - (Phase 2) makes Halo of Spores roll its damage die twice.
 * Temporary HP and the "ends when temp HP lost" rule are intentionally NOT
 * implemented.
 *
 * Hard-coded `effect.changes` mirror ddb-importer (`dist/main.mjs`,
 * class SymbioticEntity, v7.3.3):
 *   unsignedAddChange("1d6[necrotic]", 20, "system.bonuses.mwak.damage"),
 *   addChange("1", 20, "system.scale.spores.halo-of-spores.number")  // Phase 2
 * The hard-coded changes are the Tier-2 fallback; an item that already carries
 * its own "Symbiotic Entity" effect is cloned instead (see shared.mjs).
 */

// 10 minutes @ 6s/round. Fixed across editions (no 2024 variant).
const SYMBIOTIC_DURATION_ROUNDS = 100;

const isSymbioticEntityItem = (i) => i?.type === "feat"
  && (i.name?.toLowerCase() === "symbiotic entity"
      || i.system?.identifier?.toLowerCase() === "symbiotic-entity");

export default {
  id: "symbiotic-entity",
  label: "Symbiotic Entity",

  detect(activity) {
    if (!isSymbioticEntityItem(activity?.item)) return null;
    const item = activity.item;
    const hasHaloScale = !!activity.actor?.system?.scale?.spores?.["halo-of-spores"];
    dbg("dnd5e:symbiotic-entity", item.name, hasHaloScale ? "halo-scale ok" : "no halo-of-spores scale value");
    return {
      name: item.name,
      img: item.img,
      itemUuid: item.uuid,
      durationRounds: SYMBIOTIC_DURATION_ROUNDS,
    };
  },

  // Beyond20 "start by name" parity (scripts/core/beyond20.mjs:242).
  fromActor(actor) {
    const item = actor?.items?.find(isSymbioticEntityItem);
    return {
      name: item?.name ?? "Symbiotic Entity",
      img: item?.img ?? "",
      itemUuid: item?.uuid ?? null,
      durationRounds: SYMBIOTIC_DURATION_ROUNDS,
    };
  },

  effect: {
    statusId: "cst-symbiotic-entity",
    // Fallback only — the AE normally inherits the feat's own image (the
    // create flow passes record.img). Any core spore/fungus/necrotic icon.
    defaultIcon: "icons/magic/nature/root-vine-entangled-hand-green.webp",
    featNames: ["symbiotic entity"],
    changes() {
      const M = CONST.ACTIVE_EFFECT_MODES;
      return [
        // +1d6 necrotic on melee weapon attacks. The `[necrotic]` flavor makes
        // dnd5e add it as a distinct necrotic damage part (ddb-importer uses
        // this exact value).
        { key: "system.bonuses.mwak.damage", mode: M.ADD, value: "1d6[necrotic]", priority: 20 },
        // Halo of Spores: roll the damage die a second time. The Halo of Spores
        // item's damage uses @scale.spores.halo-of-spores; adding 1 to the scale
        // value's die count turns 1dX into 2dX. No-op (harmless) on actors lacking
        // the spores.halo-of-spores scale value. Mirrors ddb-importer.
        { key: "system.scale.spores.halo-of-spores.number", mode: M.ADD, value: "1", priority: 20 },
      ];
    },
  },

  view: {
    anchorToOwner: true,
    icon: "fa-solid fa-disease",
    roundsLeftKey: "COMBAT_SPELL_TIMER.SymbioticEntity.RoundsLeft",
    removeLabelKey: "COMBAT_SPELL_TIMER.SymbioticEntity.EndLabel",
    // No turnEnd: fixed 10-minute duration, no per-turn extend/end prompt.
    joinPrompt: {
      titleKey: "COMBAT_SPELL_TIMER.SymbioticEntity.AlreadyActiveTitle",
      promptKey: "COMBAT_SPELL_TIMER.SymbioticEntity.AlreadyActivePrompt",
      roundsKey: "COMBAT_SPELL_TIMER.SymbioticEntity.AlreadyActiveRounds",
      defaultRounds: () => SYMBIOTIC_DURATION_ROUNDS,
    },
  },
};
