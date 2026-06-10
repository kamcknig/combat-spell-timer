/**
 * Abstract base describing every system-specific surface the timer needs.
 * One concrete subclass per supported system at `adapter/<systemId>/index.mjs`.
 * Core never branches on `game.system.id` — it calls these methods instead.
 * @abstract
 */
export default class SystemAdapter {
  /** @type {string|null} Foundry system id this adapter handles. */
  static SYSTEM_ID = null;

  /**
   * Subscribe to the system's "a spell was cast" signal. For every trackable
   * cast, invoke `onCast(record)` with a NormalizedCast (see below). Trackable =
   * the caster is in an active combat AND the spell has a finite time duration.
   * @abstract
   * @param {(record: NormalizedCast) => void} onCast
   */
  registerCastDetection(onCast) { throw new Error(`${this.constructor.name}.registerCastDetection not implemented`); }

  /**
   * Subscribe to system events that should remove a timer early (e.g. dnd5e
   * concentration ending). Invoke `onEarlyRemove(query)` where `query` is a
   * partial match object, e.g. `{ concentrationEffectUuid }` or
   * `{ casterActorUuid }`. Default: no early-removal triggers.
   * @param {(query: object) => void} onEarlyRemove
   */
  registerEarlyRemoval(onEarlyRemove) { /* optional */ }

  /**
   * Called when a timer row is manually removed by the user (GM or caster).
   * System adapters can use this to perform additional cleanup, e.g. dropping
   * concentration. Default: no-op.
   * @param {object} record  The timer record being removed.
   */
  onManualRemove(record) { /* optional */ }

  /**
   * Called (GM-side) when a timer expires naturally after all rounds elapse.
   * System adapters can use this to clean up system state, e.g. dropping
   * concentration. Default: no-op.
   * @param {object} record  The expired timer record.
   */
  onTimerExpired(record) { /* optional */ }

  /**
   * Check whether the actor has an ongoing trackable spell that should be
   * offered to the GM when the actor joins combat. Returns a NormalizedCast if
   * found, or null if not. Default: null (no detection for this system).
   * @param {Actor} actor
   * @returns {Promise<import("./SystemAdapter.mjs").NormalizedCast|null>}
   */
  async getExistingSpell(actor) { return null; }

  /**
   * Cast a spell on the actor at a chosen slot level, consuming the slot, as if
   * the user activated it from their sheet. Used by the Beyond20 integration to
   * turn a D&D Beyond chat card into a real in-Foundry cast. Returns the system's
   * usage result on success, or null when nothing was cast (spell not found, no
   * usable activity, no slot available, or unsupported system). Default: null.
   * @param {Actor} actor
   * @param {{name: string, level: number}} spec  Spell name and cast (slot) level; 0 = cantrip.
   * @returns {Promise<object|null>}
   */
  async castSpell(actor, spec) { return null; }

  /**
   * List candidate spell names for the system, used to populate the spell-mapping
   * editor's autocompletion datalist. Free-form input is always allowed, so an
   * empty list is acceptable. Default: none.
   * @abstract
   * @returns {Promise<string[]>}
   */
  async listSpellNames() { return []; }

  /**
   * Subscribe to the system's "a timed feature was activated" signal. The adapter
   * dispatches through its feature registry: for every registered feature that
   * recognizes the used activity, invoke `onFeature(record)` with a feature start
   * record ({ featureId, casterActorUuid, name, img, itemUuid, durationRounds }).
   * Default: no-op.
   * @param {(record: object) => void} onFeature
   */
  registerFeatureDetection(onFeature) { /* optional */ }

  /**
   * Subscribe to system events that should end an active feature early
   * (e.g. actor gains unconscious/incapacitated). Invoke
   * `onEarlyEnd({ featureId, casterActorUuid })`. Default: no-op.
   * @param {(query: object) => void} onEarlyEnd
   */
  registerFeatureEarlyEnd(onEarlyEnd) { /* optional */ }

  /**
   * Subscribe to system events that should run a feature's cleanup after its
   * module-owned effect is removed by any path (e.g. companion items created by
   * the feature's onStart hook). Default: no-op.
   */
  registerFeatureCleanup() { /* optional */ }

  /**
   * Create the module-owned ActiveEffect for a feature on the actor so its
   * bonuses apply and the token shows the feature icon. Implementations may clone
   * the effect off the actor's source item, falling back to hard-coded changes.
   * Returns the new AE's UUID, or null if unsupported.
   * @param {Actor} actor
   * @param {string} featureId
   * @param {{img?:string, itemUuid?:string}} opts
   * @returns {Promise<string|null>}
   */
  async applyFeatureEffect(actor, featureId, opts) { return null; }

  /**
   * Delete a feature's module-owned AE during early-end / cleanup. Default: no-op.
   * @param {{featureId?:string, casterActorUuid?:string, effectUuid?:string}} query
   */
  async removeFeatureEffect(query) { /* optional */ }

  /**
   * Remove an applied (non-timer) ActiveEffect chosen from the combatant effect
   * panel, by uuid. Systems may override to also unwind linked state (e.g. end a
   * concentration spell). Default: just delete the effect.
   * @param {string} effectUuid
   */
  async removeAppliedEffect(effectUuid) {
    const e = await fromUuid(effectUuid).catch(() => null);
    await e?.delete();
  }

  /**
   * The module spell timer whose countdown an applied effect should mirror, so a
   * spell-applied effect's icon counts down in lockstep with its spell row rather
   * than on its own per-target expiry clock. Default: no link.
   * @param {ActiveEffect} effect
   * @param {object[]} timers  This combat's timer records.
   * @returns {object|null}
   */
  getEffectTimer(effect, timers) { return null; }

  /**
   * Set a standalone applied effect's remaining duration to `rounds` whole combat
   * rounds (no module timer drives it). Default: anchor a rounds-based duration to
   * the current combat round, then refresh the tracker.
   * @param {string} effectUuid
   * @param {number} rounds
   */
  async setAppliedEffectRounds(effectUuid, rounds) {
    const effect = await fromUuid(effectUuid).catch(() => null);
    if (!effect) return;
    const combat = game.combat;
    await effect.update({
      "duration.startRound": combat?.round ?? null,
      "duration.startTurn": combat?.turn ?? 0,
      "duration.rounds": rounds,
      "duration.seconds": null,
    });
    ui.combat?.render(); // updateActiveEffect doesn't re-render the tracker on its own
  }

  /**
   * After a timer's remaining rounds were changed, bring any linked system
   * effect(s) into line so they don't expire before the new duration. Default:
   * no-op (the module timer alone drives the display).
   * @param {object} timer  The updated timer record.
   * @param {number} rounds
   */
  async setTimerEffectRounds(timer, rounds) { /* optional */ }

  /**
   * Every registered feature the actor currently has an active module-owned AE
   * for, as { featureId, name, img, effectUuid } records. Default: none.
   * @param {Actor} actor
   * @returns {Promise<object[]>}
   */
  async getExistingFeatures(actor) { return []; }

  /**
   * The system-agnostic presentation/policy view for a feature, or null when the
   * id is not a registered feature (e.g. for spell timers). Default: null.
   * @param {string} featureId
   * @returns {FeatureView|null}
   */
  getFeatureView(featureId) { return null; }

  /**
   * Build a feature start record from just an actor (no activity), e.g. for the
   * Beyond20 "start by name" path. Default: null.
   * @param {Actor} actor
   * @param {string} featureId
   * @returns {object|null}
   */
  getFeatureStartRecord(actor, featureId) { return null; }
}

/**
 * @typedef {object} NormalizedCast  System-agnostic description of a cast.
 * @property {string}  name                     Spell display name.
 * @property {string}  img                      Spell image path.
 * @property {string}  casterActorUuid          UUID of the casting actor.
 * @property {number}  durationRounds           Whole combat rounds (>0).
 * @property {boolean} concentration            Whether it's a concentration spell.
 * @property {string}  [spellUuid]              Reference to the spell item.
 * @property {number}  [spellLevel]             Cast level.
 * @property {string}  [concentrationEffectUuid] Concentration AE uuid, for early removal.
 */

/**
 * @typedef {object} FeatureView  System-agnostic presentation/policy for a feature,
 *   exposed to core + UI so they never import a system adapter directly.
 * @property {boolean} anchorToOwner          Row anchors to the owner; no initiative input.
 * @property {string}  [icon]                 FA icon for dialogs.
 * @property {string}  roundsLeftKey          i18n key for the "N rounds left" sub-line.
 * @property {string}  removeLabelKey         i18n key for the context-menu / delete label.
 * @property {object}  [turnEnd]              Turn-end policy; absent → plain countdown.
 * @property {"confirm"} turnEnd.mode
 * @property {string}  turnEnd.titleKey
 * @property {string}  turnEnd.extendKey
 * @property {string}  turnEnd.endKey
 * @property {string}  [turnEnd.icon]
 * @property {(actor: Actor) => string}  turnEnd.promptKey   Edition-aware prompt i18n key.
 * @property {(actor: Actor) => boolean} [turnEnd.skip]      e.g. Persistent Rage (L15) auto-extends.
 * @property {object}  [joinPrompt]           Shown when an already-active feature joins combat.
 * @property {string}  joinPrompt.titleKey
 * @property {string}  joinPrompt.promptKey
 * @property {string}  joinPrompt.roundsKey
 * @property {(actor: Actor) => number} joinPrompt.defaultRounds
 */
