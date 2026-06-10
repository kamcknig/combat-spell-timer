/**
 * dnd5e Barbarian "Rage" feature descriptor — the single source of truth for
 * everything unique to Rage. Absorbs the former effect-builder changes plus
 * the Phase-2 detection / early-end / UI logic.
 *
 * Hard-coded `effect.changes` mirror ddb-importer (`dist/main.mjs`, class Rage):
 *   unsignedAddChange("@scale.barbarian.rage-damage", 20, "system.bonuses.mwak.damage"),
 *   damageResistanceChange("piercing"|"slashing"|"bludgeoning"),
 *   unsignedAddChange(ADV_MODE.ADVANTAGE, 20, "system.abilities.str.save.roll.mode"),
 *   unsignedAddChange(ADV_MODE.ADVANTAGE, 20, "system.abilities.str.check.roll.mode")
 * 2014 and 2024 share identical changes; the melee bonus scales at roll time.
 *
 * Rage-start augmentations (both gated only on the actor having the feature):
 *  - Path of Wild Magic: Wild Surge fires automatically on every rage entry —
 *    the actor's own Wild Surge item is activated so dnd5e rolls the table and
 *    applies its effects. This module adds no timer or AE for the surge effects.
 *  - Path of the Beast: `onStart` prompts for a bestial form and creates the
 *    chosen natural weapon. `onEffectDeleted` removes the weapon when the rage
 *    ends by any path (turn-end dialog, natural expiry, right-click, unconscious
 *    early-end, re-rage refresh, or manual AE deletion).
 */

import { hasFormOfTheBeast, promptBeastForm, createBeastWeapon, removeBeastWeapons } from "./form-of-the-beast.mjs";
import { triggerWildSurge, removeWildSurgeEffects, onWildSurgeActivity } from "./wild-surge.mjs";

const isModern = () => typeof dnd5e !== "undefined" && dnd5e?.settings?.rulesVersion === "modern";
const barbLevel = (actor) => actor?.classes?.barbarian?.system?.levels ?? 0;
const rageDuration = () => (isModern() ? 100 : 10);
const isRageItem = (i) => i?.type === "feat"
  && (i.name?.toLowerCase() === "rage" || i.system?.identifier?.toLowerCase() === "rage");

export default {
  id: "rage",
  label: "Rage",

  detect(activity) {
    if (!isRageItem(activity?.item)) return null;
    const item = activity.item;
    return { name: item.name, img: item.img, itemUuid: item.uuid, durationRounds: rageDuration() };
  },

  fromActor(actor) {
    const item = actor?.items?.find(isRageItem);
    return { name: item?.name ?? "Rage", img: item?.img ?? "", itemUuid: item?.uuid ?? null, durationRounds: rageDuration() };
  },

  endsEarlyOnEffect(effect, actor) {
    const modern = isModern(), lvl = barbLevel(actor);
    const onUnconscious = effect.statuses?.has?.("unconscious") && (!modern || lvl >= 15);
    const onIncapacitated = modern && effect.statuses?.has?.("incapacitated");
    return onUnconscious || onIncapacitated;
  },

  /**
   * Rage-start augmentations, each gated only on the actor having the feature
   * (no edition gate). Runs when a rage freshly starts; never on combat join.
   * A re-rage refresh runs them again — correct for Wild Surge, which triggers
   * on every rage entry. Neither is awaited: their dialogs and rolls resolve
   * in parallel so the rage itself (AE + timer) starts immediately.
   *  - Path of Wild Magic: Wild Surge fires automatically — activate the
   *    actor's own item so dnd5e rolls the table and applies its effects.
   *  - Path of the Beast: offer the Form of the Beast transformation and
   *    manifest the chosen natural weapon.
   */
  onStart(actor) {
    triggerWildSurge(actor).catch(err => console.error("combat-spell-timer | wild surge trigger failed", err));
    if (hasFormOfTheBeast(actor)) {
      promptBeastForm(actor)
        // Guard on the status: if the rage already ended while the dialog sat
        // open, don't manifest a weapon nothing will clean up until next rage.
        .then(form => form && actor.statuses?.has?.("cst-raging") ? createBeastWeapon(actor, form, "rage") : null)
        .catch(err => console.error("combat-spell-timer | form of the beast failed", err));
    }
  },

  /**
   * Any activity was used (dnd5e.postUseActivity) → let Wild Surge create a
   * marker AE for table results with lasting riders that apply no effect of
   * their own (e.g. roll 3, Exploding Spirit — re-summonable as a bonus action).
   */
  onActivityUse(activity) {
    return onWildSurgeActivity(activity);
  },

  /**
   * Rage ended (AE deleted by any path) → end everything bound to the rage's
   * duration: the Form of the Beast weapon and any rage-bound Wild Surge
   * effects (e.g. roll 6, "Multicolored Light AC Bonus").
   */
  onEffectDeleted(actor) {
    return Promise.all([
      removeBeastWeapons(actor, "rage"),
      removeWildSurgeEffects(actor),
    ]);
  },

  effect: {
    statusId: "cst-raging",
    defaultIcon: "icons/creatures/abilities/mouth-teeth-human.webp",
    featNames: ["rage"],
    changes() {
      const M = CONST.ACTIVE_EFFECT_MODES;
      const ADV = CONFIG.Dice?.D20Roll?.ADV_MODE?.ADVANTAGE ?? 1;
      return [
        { key: "system.bonuses.mwak.damage",           mode: M.ADD, value: "@scale.barbarian.rage-damage", priority: 20 },
        { key: "system.traits.dr.value",               mode: M.ADD, value: "piercing",    priority: 20 },
        { key: "system.traits.dr.value",               mode: M.ADD, value: "slashing",    priority: 20 },
        { key: "system.traits.dr.value",               mode: M.ADD, value: "bludgeoning", priority: 20 },
        { key: "system.abilities.str.save.roll.mode",  mode: M.ADD, value: String(ADV),   priority: 20 },
        { key: "system.abilities.str.check.roll.mode", mode: M.ADD, value: String(ADV),   priority: 20 },
      ];
    },
  },

  view: {
    anchorToOwner: true,
    icon: "fa-solid fa-fire",
    roundsLeftKey: "COMBAT_SPELL_TIMER.Rage.RoundsLeft",
    removeLabelKey: "COMBAT_SPELL_TIMER.Rage.EndRage",
    turnEnd: {
      mode: "confirm",
      titleKey: "COMBAT_SPELL_TIMER.Rage.ExtendTitle",
      extendKey: "COMBAT_SPELL_TIMER.Rage.Extend",
      endKey: "COMBAT_SPELL_TIMER.Rage.EndRage",
      icon: "fa-solid fa-fire",
      promptKey: () => isModern() ? "COMBAT_SPELL_TIMER.Rage.ExtendPrompt2024" : "COMBAT_SPELL_TIMER.Rage.ExtendPrompt2014",
      skip: (actor) => isModern() && barbLevel(actor) >= 15,
    },
    joinPrompt: {
      titleKey: "COMBAT_SPELL_TIMER.Rage.AlreadyRagingTitle",
      promptKey: "COMBAT_SPELL_TIMER.Rage.AlreadyRagingPrompt",
      roundsKey: "COMBAT_SPELL_TIMER.Rage.AlreadyRagingRounds",
      defaultRounds: () => rageDuration(),
    },
  },
};
