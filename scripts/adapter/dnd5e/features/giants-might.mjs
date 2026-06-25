import { dbg } from "../../../utils/debug.mjs";

/**
 * dnd5e Fighter (Rune Knight) "Giant's Might" feature descriptor.
 *
 * The feat has TWO activities:
 *  - the enlarge ("use") activity — a UTILITY activity that we detect and that
 *    auto-applies the buff (size Large + Advantage on STR saves/checks),
 *    lasting 1 minute (10 rounds);
 *  - a "Bonus Damage" DAMAGE activity (1d6) — LEFT ALONE (never detected).
 *
 * Effect changes mirror ddb-importer (`dist/main.mjs`, class GiantsMight):
 *   overrideChange("lg", 25, "system.traits.size")
 *   unsignedAddChange(ADV_MODE.ADVANTAGE, 20, "system.abilities.str.save.roll.mode")
 *   unsignedAddChange(ADV_MODE.ADVANTAGE, 20, "system.abilities.str.check.roll.mode")
 * The enricher's ATL.width/height changes need the Active Token Effects module
 * and are inert in core dnd5e — Phase 2 resizes the token directly instead.
 */

// 1 minute @ 6s/round. Rune Knight content has no 2014/2024 split here.
const GIANTS_MIGHT_DURATION_ROUNDS = 10;
const STATUS_ID = "cst-giants-might";

const isGiantsMightItem = (i) => i?.type === "feat"
  && (i.name?.toLowerCase() === "giant's might"
      || i.system?.identifier?.toLowerCase() === "giants-might");

/**
 * True only for the enlarge ("use") activity of a Giant's Might feat. The
 * Bonus Damage rider is a DAMAGE activity and is excluded.
 */
function isGiantsMightUseActivity(activity) {
  if (!isGiantsMightItem(activity?.item)) return false;
  if (activity?.type === "damage") return false;       // the "Bonus Damage" rider
  if (activity?.damage?.parts?.length) return false;   // defensive
  return true;
}

const giantsMight = {
  id: "giants-might",
  label: "Giant's Might",

  detect(activity) {
    if (!isGiantsMightUseActivity(activity)) return null;
    const item = activity.item;
    dbg("dnd5e:giants-might:detect", item.name, activity.name ?? activity.type);
    return {
      name: item.name,
      img: item.img,
      itemUuid: item.uuid,
      durationRounds: GIANTS_MIGHT_DURATION_ROUNDS,
    };
  },

  // Beyond20 "start by name" parity (scripts/core/beyond20.mjs).
  fromActor(actor) {
    const item = actor?.items?.find(isGiantsMightItem);
    return {
      name: item?.name ?? "Giant's Might",
      img: item?.img ?? "",
      itemUuid: item?.uuid ?? null,
      durationRounds: GIANTS_MIGHT_DURATION_ROUNDS,
    };
  },

  effect: {
    statusId: STATUS_ID,
    // Fallback only — the AE normally inherits the feat's own image (record.img).
    // Adjust if this core path 404s on your install.
    defaultIcon: "icons/magic/control/buff-strength-muscle-damage-orange.webp",
    featNames: ["giant's might"],
    // Never clone the imported effect: its ATL.width/height changes are inert in
    // core dnd5e. Build from the ddb-importer core changes below.
    hardcodedOnly: true,
    changes() {
      const M = CONST.ACTIVE_EFFECT_MODES;
      const ADV = CONFIG.Dice?.D20Roll?.ADV_MODE?.ADVANTAGE ?? 1;
      return [
        { key: "system.traits.size",                   mode: M.OVERRIDE, value: "lg",        priority: 25 },
        { key: "system.abilities.str.save.roll.mode",  mode: M.ADD,      value: String(ADV), priority: 20 },
        { key: "system.abilities.str.check.roll.mode", mode: M.ADD,      value: String(ADV), priority: 20 },
      ];
    },
  },

  view: {
    anchorToOwner: true,
    icon: "fa-solid fa-up-right-and-down-left-from-center",
    roundsLeftKey: "COMBAT_SPELL_TIMER.GiantsMight.RoundsLeft",
    removeLabelKey: "COMBAT_SPELL_TIMER.GiantsMight.EndLabel",
    // Fixed 1-minute duration — no per-turn extend/end prompt (no turnEnd).
    joinPrompt: {
      titleKey: "COMBAT_SPELL_TIMER.GiantsMight.AlreadyActiveTitle",
      promptKey: "COMBAT_SPELL_TIMER.GiantsMight.AlreadyActivePrompt",
      roundsKey: "COMBAT_SPELL_TIMER.GiantsMight.AlreadyActiveRounds",
      defaultRounds: () => GIANTS_MIGHT_DURATION_ROUNDS,
    },
  },
};

export default giantsMight;
