import { isWriter, addTimer, setInitiative, removeTimers } from "./socket.mjs";
import { getTimers } from "./store.mjs";
import { getAdapter } from "../adapter/index.mjs";
import { dbg } from "../utils/debug.mjs";

/**
 * createCombatant hook. When a combatant is added to combat, check whether
 * their actor is already concentrating on a trackable spell and, if so, show
 * the GM a dialog to add a timer or drop concentration immediately.
 * Only the active GM sees and acts on the dialog.
 * @param {Combatant} combatant
 */
export async function onCreateCombatant(combatant) {
  if (!isWriter()) return;

  const actor = combatant.actor;
  const combat = combatant.parent;
  if (!actor || !combat) return;

  // If a timer for this actor already exists in this combat the user previously
  // chose to keep it when the combatant was removed — don't prompt again.
  if (getTimers(combat).some(t => t.casterActorUuid === actor.uuid)) return;

  const spell = await getAdapter().getExistingSpell(actor);
  dbg("combatant:check", combatant.name, spell ? spell.name : "no concentration");

  if (spell) {
    const spellName = foundry.utils.escapeHTML(spell.name);
    const actorName = foundry.utils.escapeHTML(combatant.name);

    // ApplicationV2 dialog (the system uses v2). Left as a plain DialogV2 so it
    // inherits the standard dark window styling, like the system's core sheets
    // (e.g. Update Combatant); the dnd5e2 class would force the light parchment
    // look unless <body> is theme-dark, so we deliberately don't add it.
    new foundry.applications.api.DialogV2({
      window: { title: game.i18n.localize("COMBAT_SPELL_TIMER.ExistingTitle") },
      content: `
        <div class="cst-existing-dialog">
          <div class="cst-existing-header">
            <img src="${spell.img}" alt="${spellName}">
            <div>
              <strong>${spellName}</strong>
              <div>${game.i18n.format("COMBAT_SPELL_TIMER.ExistingSubtitle", { name: actorName })}</div>
            </div>
          </div>
          <label class="cst-existing-rounds">
            ${game.i18n.localize("COMBAT_SPELL_TIMER.RoundsRemaining")}
            <input type="number" name="rounds" value="${spell.durationRounds}" min="1">
          </label>
          <label class="cst-existing-initiative">
            ${game.i18n.localize("COMBAT_SPELL_TIMER.InitiativeOptional")}
            <input type="number" name="initiative" value="${combatant.initiative ?? ""}" step="any">
            <p class="hint">${game.i18n.localize("COMBAT_SPELL_TIMER.InitiativeHint")}</p>
          </label>
        </div>
      `,
      buttons: [
        {
          action: "submit",
          icon: "fa-solid fa-check",
          label: game.i18n.localize("COMBAT_SPELL_TIMER.AddTimer"),
          default: true,
          callback: (event, button) => {
            const rounds = parseInt(button.form.elements.rounds.value, 10);
            if (!rounds || rounds < 1) return;
            const initiativeRaw = button.form.elements.initiative.value;
            const initiative = initiativeRaw !== "" && Number.isNumeric(initiativeRaw)
              ? parseFloat(initiativeRaw)
              : null;
            addTimer(combat.id, {
              id: foundry.utils.randomID(),
              name: spell.name,
              img: spell.img,
              casterActorUuid: spell.casterActorUuid,
              casterCombatantId: combatant.id,
              castRound: Math.max(combat.round, 1),
              initiative,
              durationRounds: rounds,
              concentration: true,
              spellUuid: spell.spellUuid ?? null,
              spellLevel: spell.spellLevel ?? null,
              concentrationEffectUuid: spell.concentrationEffectUuid ?? null
            });
          }
        },
        {
          action: "remove",
          icon: "fa-solid fa-xmark",
          label: game.i18n.localize("COMBAT_SPELL_TIMER.RemoveConcentration"),
          callback: () => {
            fromUuid(spell.concentrationEffectUuid).then(e => e?.delete());
          }
        }
      ]
    }).render({ force: true });
    return; // concentration dialog shown — skip the feature check
  }

  const features = await getAdapter().getExistingFeatures(actor);
  dbg("combatant:check-features", combatant.name, features.map(f => f.featureId).join(",") || "none");
  for (const f of features) {
    const view = getAdapter().getFeatureView(f.featureId);
    if (view?.joinPrompt) await showFeatureJoinDialog(f, view, combatant, combat);
  }
}

/**
 * Prompt the GM to add a timer for an already-active feature whose actor just
 * joined combat (e.g. "Already Raging"). Generic: all the labels/rounds come
 * from the feature's `view.joinPrompt`; the timer record uses the generic shape.
 * @param {{featureId:string, name:string, img:string, effectUuid:string}} feature
 * @param {import("../adapter/SystemAdapter.mjs").FeatureView} view
 * @param {Combatant} combatant
 * @param {Combat} combat
 */
async function showFeatureJoinDialog(feature, view, combatant, combat) {
  const jp = view.joinPrompt;
  const actor = combatant.actor;
  const defaultRounds = jp.defaultRounds?.(actor) ?? 10;
  const actorName = foundry.utils.escapeHTML(combatant.name ?? feature.name);

  const rounds = await foundry.applications.api.DialogV2.prompt({
    rejectClose: true,
    window: { title: game.i18n.localize(jp.titleKey), icon: view.icon },
    content: `
      <div class="cst-existing-dialog">
        <div class="cst-existing-header">
          <img src="${feature.img}" alt="${foundry.utils.escapeHTML(feature.name)}"
               style="width:48px;height:48px;border-radius:4px;object-fit:cover">
          <p>${game.i18n.format(jp.promptKey, { name: actorName })}</p>
        </div>
        <label class="cst-existing-rounds">
          ${game.i18n.localize(jp.roundsKey)}
          <input type="number" name="rounds" min="1" max="${defaultRounds}" value="${defaultRounds}">
        </label>
      </div>
    `,
    ok: {
      label: game.i18n.localize("COMBAT_SPELL_TIMER.AddTimer"),
      callback: (_event, button) => {
        const v = parseInt(button.form.elements.rounds.value, 10);
        return Number.isNaN(v) || v < 1 ? null : v;
      }
    }
  }).catch(() => null);

  if (!rounds) return;
  addTimer(combat.id, {
    id: foundry.utils.randomID(),
    type: feature.featureId,
    name: feature.name,
    img: feature.img,
    casterActorUuid: actor.uuid,
    casterCombatantId: combatant.id,
    castRound: Math.max(combat.round, 1),
    castTurn: combat.turn ?? 0,
    initiative: null,
    anchorToOwner: view.anchorToOwner ?? false,
    durationRounds: rounds,
    effectUuid: feature.effectUuid,
    concentration: false
  });
}

/**
 * updateCombatant hook. The first time the owner's initiative is set, copy it
 * onto any of this combat's timers for that combatant that don't yet have an
 * initiative — a spell cast before the owner rolled inherits the owner's slot
 * once, then stays put even if the owner's initiative later changes. Only the
 * active GM writes; the GM-side store ignores timers that already have one.
 * @param {Combatant} combatant
 * @param {object} changed  The update diff.
 */
export function onUpdateCombatant(combatant, changed) {
  if (!isWriter()) return;
  if (!("initiative" in changed)) return;
  const initiative = combatant.initiative;
  if (initiative == null) return; // cleared, not set — nothing to inherit
  const combat = combatant.parent;
  if (!combat) return;
  // Skip the write entirely unless some timer is still waiting for an initiative.
  if (!getTimers(combat).some(t => t.casterCombatantId === combatant.id && t.initiative == null)) return;
  dbg("combatant:initiative", combatant.name, initiative);
  setInitiative(combat.id, combatant.id, initiative);
}

/**
 * deleteCombatant hook. When a combatant that owns spell timers is removed from
 * combat, ask the GM whether to also remove those timers. Confirming deletes the
 * timer records ONLY — concentration is intentionally left intact, since the
 * owner merely left this combat. Declining keeps the timers in place. Only the
 * active GM is prompted.
 * @param {Combatant} combatant
 */
export async function onDeleteCombatant(combatant) {
  if (!isWriter()) return;
  const combat = combatant.parent;
  // Skip if the parent combat itself is gone (e.g. the whole encounter was deleted).
  if (!combat || !game.combats.has(combat.id)) return;

  const timers = getTimers(combat).filter(t => t.casterCombatantId === combatant.id);
  if (!timers.length) return;

  const actorName = foundry.utils.escapeHTML(combatant.name);
  const list = timers.map(t => {
    const name = foundry.utils.escapeHTML(t.name);
    const img = foundry.utils.escapeHTML(t.img ?? "");
    return `<li><img src="${img}" alt="${name}"><span>${name}</span></li>`;
  }).join("");
  const isFeature = (t) => !!getAdapter().getFeatureView(t.type);
  const allFeatures = timers.every(isFeature);
  const hasSpell = timers.some(t => !isFeature(t));
  const confirmLabel = allFeatures && timers.length
    ? game.i18n.localize(getAdapter().getFeatureView(timers[0].type).removeLabelKey)
    : game.i18n.localize("COMBAT_SPELL_TIMER.RemoveSpellTimer");
  const confirmed = await foundry.applications.api.DialogV2.confirm({
    rejectClose: false, // closing the dialog counts as "keep"
    window: { title: game.i18n.localize("COMBAT_SPELL_TIMER.RemoveOnDeleteTitle"), icon: "fa-solid fa-trash" },
    content: `
      <p>${game.i18n.format("COMBAT_SPELL_TIMER.RemoveOnDeletePrompt", { name: actorName })}</p>
      <ul class="cst-timer-list">${list}</ul>
      ${hasSpell ? `<p class="notes">${game.i18n.localize("COMBAT_SPELL_TIMER.RemoveOnDeleteNote")}</p>` : ""}
    `,
    yes: { label: confirmLabel },
    no: { label: game.i18n.localize("COMBAT_SPELL_TIMER.Keep") }
  });
  if (!confirmed) return;

  dbg("combatant:delete-remove", combatant.name, timers.length);
  // Remove timer records. For feature timers, also delete the feature AE via onManualRemove.
  // Spell timer concentration is intentionally left intact — owner merely left combat.
  for (const t of timers) {
    if (isFeature(t)) getAdapter().onManualRemove(t);
  }
  removeTimers(combat.id, { casterCombatantId: combatant.id });
}
