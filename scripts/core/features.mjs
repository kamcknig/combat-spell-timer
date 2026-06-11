import { addTimer, removeTimers, isWriter } from "./socket.mjs";
import { getTimers } from "./store.mjs";
import { getAdapter } from "../adapter/index.mjs";
import { dbg } from "../utils/debug.mjs";

/**
 * Generic feature orchestration (replaces the former Rage-specific core module).
 * Driven entirely by the adapter's feature registry: detection, effect
 * apply/remove, the turn-end "confirm" dialog, and timer records all flow
 * through opaque feature views — core never imports the dnd5e adapter directly.
 */

/**
 * Adapter detected a feature activation → create its AE and add timers to every
 * combat the actor is in.
 * @param {object} record  { featureId, casterActorUuid, name, img, itemUuid, durationRounds }
 * @param {(actor: Actor, featureId: string, opts: object) => Promise<string|null>} applyEffect
 *   Adapter-provided fn that creates the feature AE; returns its UUID or null.
 */
export async function onFeatureStart(record, applyEffect) {
  const actor = fromUuidSync(record.casterActorUuid);
  if (!actor) return;
  const view = getAdapter().getFeatureView(record.featureId) ?? {};
  dbg("feature:start", record.featureId, `${record.durationRounds}r`);

  // Refresh semantics: starting a feature that's already running replaces the
  // prior instance. Drop any stale timers and the old AE first so we never stack
  // duplicate timers for the same feature — each would otherwise fire its own
  // turn-end dialog (e.g. two "Extend Rage?" prompts per turn).
  for (const combat of game.combats) {
    removeTimers(combat.id, { type: record.featureId, casterActorUuid: record.casterActorUuid });
  }
  await getAdapter().removeFeatureEffect?.({ featureId: record.featureId, casterActorUuid: record.casterActorUuid });

  const effectUuid = await applyEffect(actor, record.featureId, { img: record.img, itemUuid: record.itemUuid, durationRounds: record.durationRounds });

  for (const combat of game.combats) {
    const [combatant] = combat.getCombatantsByActor(actor);
    if (!combatant) continue;
    addTimer(combat.id, {
      id: foundry.utils.randomID(),
      type: record.featureId,
      name: record.name,
      img: record.img,
      casterActorUuid: record.casterActorUuid,
      casterCombatantId: combatant.id,
      castRound: Math.max(combat.round, 1),
      castTurn: combat.turn ?? 0,
      initiative: null,
      anchorToOwner: view.anchorToOwner ?? false,
      durationRounds: record.durationRounds,
      effectUuid: effectUuid ?? null,
      concentration: false,
    });
  }
}

/**
 * Feature ended early (e.g. unconscious/incapacitated) → drop timers + AE.
 * Works in-combat (with a timer) and outside combat (no timer record).
 * @param {object} query  { featureId, casterActorUuid }
 */
export async function onFeatureEarlyEnd(query) {
  dbg("feature:early-end", query);
  const match = (t) => t.type === query.featureId
    && (!query.casterActorUuid || t.casterActorUuid === query.casterActorUuid);
  let effectUuid = null;
  for (const combat of game.combats) {
    const tmr = getTimers(combat).find(match);
    if (!tmr) continue;
    if (!effectUuid && tmr.effectUuid) effectUuid = tmr.effectUuid;
    removeTimers(combat.id, { type: query.featureId, casterActorUuid: query.casterActorUuid });
  }
  await getAdapter().removeFeatureEffect?.({ featureId: query.featureId, casterActorUuid: query.casterActorUuid, effectUuid });
}

/**
 * A combatant's turn ended → run any "confirm" turn-end dialog for its feature
 * timers. Audience rules:
 *  - Player character (any non-GM owner): ONLY the owner is prompted, never the
 *    GM. If no owner is logged in, the feature auto-extends (the timer simply
 *    keeps counting) and every GM is notified.
 *  - NPC (no player owner): the active GM is prompted, as before.
 * @param {Combat} combat
 * @param {{round:number, turn:number}} previous  The turn that just ended.
 */
export async function onFeatureTurnEnd(combat, previous) {
  const prev = combat.turns[previous.turn];
  if (!prev) return;
  const timers = getTimers(combat).filter(t => {
    const mode = getAdapter().getFeatureView(t.type)?.turnEnd?.mode;
    return (mode === "confirm" || mode === "expire")
      && t.casterCombatantId === prev.id
      && !(previous.round === t.castRound && previous.turn === (t.castTurn ?? -1));
  });
  if (!timers.length) return;

  // "expire" timers end automatically at the end of the caster's turn — the
  // rules fix their duration ("until the end of your next turn"), so there is
  // nothing to confirm. Writer-gated: exactly one client removes the timer and
  // runs the adapter cleanup.
  const expiring = timers.filter(t => getAdapter().getFeatureView(t.type)?.turnEnd?.mode === "expire");
  if (expiring.length && isWriter()) {
    for (const t of expiring) {
      dbg("feature:turn-end-expire", t.type, t.name);
      removeTimers(combat.id, { id: t.id });
      getAdapter().onManualRemove(t);
    }
  }

  const actor = fromUuidSync(timers[0].casterActorUuid);
  if (!actor) return;

  // Only timers that would actually prompt — a feature may auto-extend by policy
  // (e.g. Persistent Rage at L15+), in which case there's nothing to confirm.
  const prompts = timers.filter(t => {
    const te = getAdapter().getFeatureView(t.type)?.turnEnd;
    return te?.mode === "confirm" && !te.skip?.(actor);
  });
  if (!prompts.length) return;

  const isPC = actor.hasPlayerOwner;
  const hasActiveOwner = game.users.some(u => !u.isGM && u.active && actor.testUserPermission(u, "OWNER"));

  if (isPC) {
    if (hasActiveOwner) {
      // Only the player owner is prompted — not the GM, even though the GM owns it.
      if (game.user.isGM || !actor.isOwner) return;
    } else {
      // Owner offline → auto-extend (no-op; the timer keeps counting) and tell
      // every GM it happened. Each GM client emits its own notification.
      if (game.user.isGM) {
        const name = combat.combatants.get(prompts[0].casterCombatantId)?.name ?? actor.name;
        for (const t of prompts) {
          ui.notifications?.info(game.i18n.format("COMBAT_SPELL_TIMER.FeatureAutoExtended", { feature: t.name, actor: name }));
        }
      }
      return;
    }
  } else if (!isWriter()) {
    return; // NPC → only the active GM prompts.
  }

  for (const t of prompts) await showTurnEndDialog(t, combat, actor);
}

/**
 * Open turn-end dialogs keyed by timer id → { dialog, finish }. Ensures one
 * prompt per timer (no stacking when several turns elapse unanswered), and lets
 * a dialog be dismissed when its feature ends by another path.
 */
const openTurnEndDialogs = new Map();

async function showTurnEndDialog(t, combat, actor) {
  const view = getAdapter().getFeatureView(t.type);
  const te = view?.turnEnd;
  if (!te || te.skip?.(actor)) return;      // e.g. Persistent Rage (L15) auto-extends
  if (openTurnEndDialogs.has(t.id)) return; // one prompt per timer — never stack

  let settle;
  const outcome = new Promise(r => settle = r);
  // Resolve exactly once and drop from the registry. choice ∈ extend|end|close|dismiss.
  const finish = (choice) => {
    if (!openTurnEndDialogs.has(t.id)) return;
    openTurnEndDialogs.delete(t.id);
    settle(choice);
  };

  const actorName = foundry.utils.escapeHTML(combat.combatants.get(t.casterCombatantId)?.name ?? t.name);
  const dialog = new foundry.applications.api.DialogV2({
    window: { title: game.i18n.localize(te.titleKey), icon: te.icon ?? view.icon },
    content: `
      <div style="display:flex;align-items:center;gap:10px;padding:4px 0">
        <img src="${t.img}" alt="${foundry.utils.escapeHTML(t.name)}" style="width:48px;height:48px;border-radius:4px;object-fit:cover">
        <div><strong>${foundry.utils.escapeHTML(t.name)}</strong>
          <p style="margin:4px 0 0">${game.i18n.format(te.promptKey(actor), { name: actorName })}</p></div>
      </div>`,
    buttons: [
      { action: "extend", icon: te.icon, label: game.i18n.localize(te.extendKey), default: true },
      { action: "end", icon: "fa-solid fa-xmark", label: game.i18n.localize(te.endKey) },
    ],
    submit: (result) => finish(result), // result is the clicked button's action
  });
  // Closing via the window ✕ (no button) counts as End, matching prior behavior.
  // A programmatic dismiss() resolves first, so this then no-ops.
  dialog.addEventListener("close", () => finish("close"));

  openTurnEndDialogs.set(t.id, { dialog, finish });
  dialog.render({ force: true });

  const choice = await outcome;
  if (choice === "end" || choice === "close") {
    removeTimers(combat.id, { id: t.id });
    getAdapter().onManualRemove(t);
  }
  // "extend" / "dismiss" → no-op (timer keeps counting down, or it already ended elsewhere)
}

/**
 * Dismiss an open turn-end dialog for a timer because its feature ended by
 * another path. Resolves it without running the End logic, then closes the window.
 * @param {string} timerId
 */
export function dismissTurnEndDialog(timerId) {
  const entry = openTurnEndDialogs.get(timerId);
  if (!entry) return;
  entry.finish("dismiss");
  entry.dialog.close();
}

/**
 * Close any open turn-end dialog whose timer no longer exists in its combat.
 * Wired to `updateCombat`, so every removal path (early-end, manual remove,
 * natural expiry, owner left combat) dismisses the dialog uniformly.
 */
export function reconcileTurnEndDialogs() {
  for (const timerId of [...openTurnEndDialogs.keys()]) {
    const exists = [...game.combats].some(c => getTimers(c).some(t => t.id === timerId));
    if (!exists) dismissTurnEndDialog(timerId);
  }
}
