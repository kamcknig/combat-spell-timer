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
 * roll can still be cancelled or retried) and `dnd5e.rollDamageV2` (the real
 * post-roll commit point — only fires once a roll actually completes, so
 * this is where entries are removed from `pending` and `onApplied` runs).
 * This makes stacking correct by construction, and makes cancel/retry safe,
 * instead of relying on N independently-registered listeners to each mutate
 * the same shared roll config without interfering with one another.
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
 * dnd5e.rollDamageV2: the real post-roll commit point. dnd5e fires this
 * (`Hooks.callAll("dnd5e.rollDamageV2", rolls, { subject: this })`) only
 * after the damage roll has actually been evaluated and posted — a
 * cancelled/undismissed configuration dialog means `rolls` ends up empty and
 * `Activity#rollDamage` returns before ever reaching this call, so this hook
 * simply never fires for a roll that didn't complete. That makes it the
 * right place to finalize "this maneuver's die was rolled": look up the
 * activity's pending entries, delete them from `pending`, and run each
 * entry's own `onApplied` callback (flips the originating message's
 * `consumed` flag, stashes follow-up bookkeeping, etc.).
 */
export function onManeuverRollDamage(rolls, data) {
  const activity = data?.subject;
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
  Hooks.on("dnd5e.rollDamageV2", onManeuverRollDamage);
}
