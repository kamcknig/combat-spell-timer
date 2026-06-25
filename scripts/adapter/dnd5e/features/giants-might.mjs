import { dbg } from "../../../utils/debug.mjs";
import { MODULE_ID } from "../../../module.mjs";
import { findModuleEffect } from "./shared.mjs";

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

/**
 * Per-actor "resize the token?" choice from the usage-dialog checkbox. Keyed by
 * actor uuid (the dialog and onStart both run on the activating client). Reset
 * to the default (true) in onPreUse before each dialog shows; set by the
 * checkbox change listener; read + cleared in onStart — so it never goes stale.
 */
const resizeChoice = new Map();

// Snapshots of the pre-enlarge size, restored on end. Token size lives on a
// token flag (the AE doesn't exist yet when onStart runs); prototype size lives
// on an actor flag.
const PRIOR_SIZE_FLAG = "giantsMightPriorSize";        // token flag: { width, height }
const PRIOR_PROTO_FLAG = "giantsMightPriorProtoSize";  // actor flag: { width, height }

/** Large token footprint (CONFIG.DND5E.actorSizes.lg.token → 2). */
const largeTokenSize = () => CONFIG.DND5E?.actorSizes?.lg?.token ?? 2;

/** The caster's TokenDocuments on the active scene (synthetic-actor safe). */
function giantTokens(actor) {
  const docs = actor?.getActiveTokens?.(false, true) ?? [];
  if (docs.length) return docs;
  return actor?.token ? [actor.token] : [];
}

/**
 * Enlarge each of the caster's tokens to Large and set the prototype token to
 * Large. Self-correcting on a re-use refresh: if a prior-size flag already
 * exists (our enlarge is active), keep that original snapshot rather than
 * snapshotting the already-enlarged size.
 */
async function enlargeTokens(actor) {
  const size = largeTokenSize();
  for (const td of giantTokens(actor)) {
    const cur = td.toObject();
    const has = cur.flags?.[MODULE_ID]?.[PRIOR_SIZE_FLAG] !== undefined;
    const prior = has ? cur.flags[MODULE_ID][PRIOR_SIZE_FLAG] : { width: cur.width, height: cur.height };
    dbg("dnd5e:giants-might:enlarge", td.uuid, `${prior.width}x${prior.height} -> ${size}x${size}`);
    await td.update({
      width: size, height: size,
      [`flags.${MODULE_ID}.${PRIOR_SIZE_FLAG}`]: prior,
    }).catch(err => console.error("combat-spell-timer | giant's might: token enlarge failed", err));
  }
  // Prototype token so tokens dropped while active are Large too. "If possible":
  // synthetic/unlinked token actors may no-op — tolerate failure.
  const proto = actor?.prototypeToken;
  if (proto) {
    const has = actor.flags?.[MODULE_ID]?.[PRIOR_PROTO_FLAG] !== undefined;
    const prior = has ? actor.flags[MODULE_ID][PRIOR_PROTO_FLAG] : { width: proto.width, height: proto.height };
    dbg("dnd5e:giants-might:enlarge-proto", actor.uuid, `${prior.width}x${prior.height} -> ${size}x${size}`);
    await actor.update({
      "prototypeToken.width": size, "prototypeToken.height": size,
      [`flags.${MODULE_ID}.${PRIOR_PROTO_FLAG}`]: prior,
    }).catch(err => console.error("combat-spell-timer | giant's might: prototype enlarge failed", err));
  }
}

/** Restore each token + the prototype to the snapshotted prior size; clear flags. */
async function restoreTokens(actor) {
  for (const td of giantTokens(actor)) {
    const prior = td.flags?.[MODULE_ID]?.[PRIOR_SIZE_FLAG];
    if (prior === undefined) continue;
    dbg("dnd5e:giants-might:restore", td.uuid, `-> ${prior.width}x${prior.height}`);
    await td.update({
      width: prior.width, height: prior.height,
      [`flags.${MODULE_ID}.-=${PRIOR_SIZE_FLAG}`]: null,
    }).catch(err => console.error("combat-spell-timer | giant's might: token restore failed", err));
  }
  const prior = actor?.flags?.[MODULE_ID]?.[PRIOR_PROTO_FLAG];
  if (prior !== undefined) {
    dbg("dnd5e:giants-might:restore-proto", actor.uuid, `-> ${prior.width}x${prior.height}`);
    await actor.update({
      "prototypeToken.width": prior.width, "prototypeToken.height": prior.height,
      [`flags.${MODULE_ID}.-=${PRIOR_PROTO_FLAG}`]: null,
    }).catch(err => console.error("combat-spell-timer | giant's might: prototype restore failed", err));
  }
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

  // Reset the resize default to checked before each usage dialog shows.
  onPreUse(activity) {
    if (!isGiantsMightUseActivity(activity)) return;
    const actor = activity.actor;
    if (actor) resizeChoice.set(actor.uuid, true);
  },

  // Apply the token/prototype enlarge (if the toggle was left checked). Runs
  // before the AE is created (applyFeatureEffect awaits onStart first), so the
  // prior-size snapshot is captured first — mirrors Wrath of the Sea's light.
  async onStart(actor) {
    const chosen = resizeChoice.get(actor?.uuid) ?? true;
    resizeChoice.delete(actor?.uuid);
    if (!chosen) { dbg("dnd5e:giants-might:onStart", "resize off"); return; }
    await enlargeTokens(actor).catch(err => console.error("combat-spell-timer | giant's might: onStart failed", err));
  },

  // AE deleted by any path → restore token + prototype size. Guard: if a Giant's
  // Might AE is still present (a re-use refresh already created the new one),
  // leave the size alone — the surviving AE owns it.
  onEffectDeleted(actor) {
    if (findModuleEffect(actor, this)) return;
    return restoreTokens(actor);
  },
};

export default giantsMight;

/**
 * renderActivityUsageDialog dispatch: inject a "Change token size" checkbox
 * (default checked) below the Consume section for the Giant's Might use
 * activity. Re-injected on every (re)render (submitOnChange) from the stored
 * per-actor value. The checkbox has NO name attribute, so it is invisible to
 * dnd5e's FormDataExtended and cannot pollute the usage config — its state is
 * read via a change listener into resizeChoice and consumed in onStart.
 * @param {ApplicationV2} app
 * @param {HTMLElement|JQuery} element
 */
export function onGiantsMightRenderUsageDialog(app, element) {
  if (!isGiantsMightUseActivity(app?.activity)) return;
  const el = element instanceof HTMLElement ? element : element?.[0];
  const form = el?.querySelector("form") ?? el;
  if (!form || form.querySelector(".cst-giants-might-resize")) return; // already injected this render

  const actor = app.actor;
  const checked = resizeChoice.get(actor?.uuid) ?? true;

  const fieldset = document.createElement("fieldset");
  fieldset.className = "cst-giants-might-resize";
  fieldset.innerHTML = `
    <div class="form-group">
      <label class="checkbox">
        <input type="checkbox" ${checked ? "checked" : ""}>
        ${game.i18n.localize("COMBAT_SPELL_TIMER.GiantsMight.ResizeToken")}
      </label>
    </div>`;
  const input = fieldset.querySelector("input");
  input.addEventListener("change", (ev) => {
    ev.stopPropagation(); // don't trigger the dialog's submitOnChange re-render
    if (actor) resizeChoice.set(actor.uuid, input.checked);
    dbg("dnd5e:giants-might:resize-toggle", input.checked);
  });

  // Below the consume toggle: insert just before the footer (the Use button).
  const footer = form.querySelector(".form-footer") ?? form.querySelector("footer");
  if (footer) footer.before(fieldset);
  else form.appendChild(fieldset);
}
