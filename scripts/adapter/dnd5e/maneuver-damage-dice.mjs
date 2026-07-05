import { dbg } from "../../utils/debug.mjs";

/**
 * Shared "extra superiority die on this Damage roll" registry for Battle
 * Master maneuvers armed against a specific weapon attack (Disarming Attack,
 * Distracting Strike, Goading Attack's weapon-card entry, Lunging Attack).
 * More than one maneuver can be armed on the same attack's activity at once
 * — each contributes its own die independently, keyed by a short source tag
 * so a refund only removes its own entry. Appending and committing are split
 * across two hooks: `dnd5e.preRollDamageV2` (append every armed die to the
 * roll, non-destructively — the config dialog hasn't even shown yet, so the
 * roll can still be cancelled or retried) and `dnd5e.postDamageRollConfiguration`
 * (the real commit point — see onManeuverRollDamage's own doc comment for why
 * this hook, specifically, and not dnd5e.rollDamageV2). This makes stacking
 * correct by construction, and makes cancel/retry safe, instead of relying on
 * N independently-registered listeners to each mutate the same shared roll
 * config without interfering with one another.
 */
const pending = new Map(); // activity.uuid -> Map<sourceTag, {dieSize, onApplied}>

/**
 * Arm `sourceTag`'s die for `activity` (overwrites any existing entry for
 * the same tag on the same activity). `onApplied(activity)` runs once the
 * die is actually added to a damage roll — use it for per-maneuver
 * bookkeeping (flip the originating message's `consumed` flag, stash data
 * for a follow-up button/tray).
 */
export function armManeuverDie(activity, sourceTag, { dieSize, onApplied } = {}) {
  if (!activity) return;
  const forActivity = pending.get(activity.uuid) ?? new Map();
  forActivity.set(sourceTag, { dieSize, onApplied });
  pending.set(activity.uuid, forActivity);
}

/** Remove `sourceTag`'s armed die for `activity` (refund before it's rolled). No-op if already consumed or never armed. */
export function disarmManeuverDie(activity, sourceTag) {
  const forActivity = pending.get(activity?.uuid);
  if (!forActivity) return;
  forActivity.delete(sourceTag);
  if (!forActivity.size) pending.delete(activity.uuid);
}

/**
 * dnd5e.preRollDamageV2: append every maneuver die armed for this activity to
 * the first damage roll's parts. This fires inside dnd5e's
 * `BasicRoll.buildConfigure`, BEFORE the damage roll configuration dialog is
 * even shown to the user — the roll can still be cancelled afterward, or the
 * user may reopen "Damage" again later. So this handler is append-only and
 * non-destructive: it does NOT delete anything from `pending` and does NOT
 * run `onApplied`. That means it's safe to re-run on a later retry after a
 * cancel (the same armed dice just get appended again). The actual commit —
 * removing the entries and firing `onApplied` — happens in
 * `onManeuverRollDamage` once the roll has actually completed.
 */
export function onManeuverPreRollDamage(config) {
  const activity = config?.subject;
  const forActivity = activity && pending.get(activity.uuid);
  if (!forActivity?.size) return;

  const roll = config.rolls?.[0];
  for (const [sourceTag, { dieSize }] of forActivity) {
    if (roll) roll.parts = [...(roll.parts ?? []), `1${dieSize}`];
    dbg("dnd5e:maneuver-damage:die-appended", activity.item?.name, sourceTag, dieSize);
  }
}

/**
 * dnd5e.postDamageRollConfiguration: the real commit point. Fires inside
 * `BasicRoll.buildConfigure`, right after the damage roll configuration
 * dialog resolves (confirmed or fast-forwarded) — `rolls` is empty if the
 * dialog was cancelled, so nothing commits then. Deliberately NOT
 * dnd5e.rollDamageV2: that hook fires only after `Activity#rollDamage`'s
 * whole `DamageRoll.build()` call returns, which is AFTER `buildPost` has
 * already created (and the chat log has already rendered once) the damage
 * message — too late for onApplied's stashed data (Disarming Attack's
 * Strength Save button, Distracting Strike's tray, Goading Attack's tray)
 * to be present for that message's first render. This hook fires before the
 * roll is even evaluated or the message created, which is early enough.
 * Looks up the activity's pending entries, deletes them from `pending`, and
 * runs each entry's own `onApplied` callback.
 * @param {Roll[]} rolls   The rolls that are about to be evaluated (empty if cancelled).
 * @param {object} config  The damage roll process configuration (same object preRollDamageV2 received).
 */
export function onManeuverRollDamage(rolls, config) {
  if (!rolls?.length) return; // dialog was cancelled — nothing to commit
  const activity = config?.subject;
  const forActivity = activity && pending.get(activity.uuid);
  if (!forActivity?.size) return;
  pending.delete(activity.uuid);

  for (const [sourceTag, { dieSize, onApplied }] of forActivity) {
    onApplied?.(activity);
    dbg("dnd5e:maneuver-damage:die-applied", activity.item?.name, sourceTag, dieSize);
  }
}

/** Register the shared drain listeners. Call once during setup. */
export function registerManeuverDamageDiceHooks() {
  Hooks.on("dnd5e.preRollDamageV2", onManeuverPreRollDamage);
  Hooks.on("dnd5e.postDamageRollConfiguration", onManeuverRollDamage);
}
