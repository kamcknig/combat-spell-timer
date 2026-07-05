import { MODULE_ID } from "../../module.mjs";

/**
 * Ensure a persisted, reusable template ActiveEffect for a mastery property
 * exists on the host item (Path to the Grave's ensureCurseTemplate
 * pattern — path-to-the-grave.mjs). An earlier version of this function
 * built a never-persisted, in-memory-only doc and registered it into the
 * item's embedded-effects Map with `{modifySource: false}` so
 * EffectApplicationElement#_onApplyEffect's lookup
 * (`chatMessage.getAssociatedItem()?.effects.get(id)`, dnd5e.mjs:63467)
 * could find it — but that Map entry only survives until the NEXT time the
 * item's embedded collection is reinitialized from `_source`, which happens
 * on essentially any subsequent actor/item update (an HP change, a turn
 * advancing, anything). In real play, "click DAMAGE" and "click Apply" are
 * rarely back-to-back, so the entry was routinely gone by the time Apply
 * was clicked, and the click silently no-op'd. A real, persisted template
 * (`transfer: false`, so it never applies to the wielder) survives any
 * reinitialization, exactly like Path to the Grave's "Cursed" template.
 * `casterActorUuid` is kept current in case the weapon changes hands.
 *
 * Coalesced against concurrent callers (dnd5e.renderChatMessage can fire
 * more than once for the same message, e.g. on a chat-log re-render sweep):
 * without this, two overlapping calls could each see no `existing` template
 * yet and both issue a create, leaving a duplicate behind.
 *
 * `duration` defaults to `{ rounds: 1 }` (today's behavior for Sap/Slow/
 * Distracting Strike). Pass `{}` for a feature whose applied effect has no
 * rules-defined expiry (e.g. Evasive Footwork's AC bonus, which lasts
 * "until you stop moving" — something this module can't detect).
 *
 * The "existing" branch also refreshes `changes` (in addition to
 * `casterActorUuid`) whenever they differ from what's stored. Sap/Slow/
 * Distracting Strike's `changes` are constant on every call, so this is a
 * no-op for them — but a feature whose bonus varies per use (Evasive
 * Footwork's AC bonus, resolved from that use's die roll) needs the
 * template brought current on every call, not just at creation.
 */
const pendingTemplateCreation = new Map(); // `${hostItem.uuid}:${flagKey}` -> in-flight Promise<ActiveEffect|null>

export async function ensureEffectTemplate(hostItem, actor, { name, img, statusId, flagKey, changes = [], duration = { rounds: 1 } }) {
  const existing = hostItem.effects.find(e => e.flags?.[MODULE_ID]?.[flagKey]);
  if (existing) {
    const updates = {};
    if (existing.flags[MODULE_ID].casterActorUuid !== actor.uuid) updates[`flags.${MODULE_ID}.casterActorUuid`] = actor.uuid;
    if (!foundry.utils.objectsEqual(existing.changes, changes)) updates.changes = changes;
    if (Object.keys(updates).length) await existing.update(updates);
    return existing;
  }

  const key = `${hostItem.uuid}:${flagKey}`;
  if (pendingTemplateCreation.has(key)) return pendingTemplateCreation.get(key);

  const promise = (async () => {
    const [created] = await hostItem.createEmbeddedDocuments("ActiveEffect", [{
      name, img: img ?? hostItem.img, statuses: [statusId], changes,
      transfer: false, disabled: false,
      duration,
      flags: { dnd5e: { isTemporary: true }, [MODULE_ID]: { [flagKey]: true, casterActorUuid: actor.uuid } },
    }]);
    return created ?? null;
  })();
  pendingTemplateCreation.set(key, promise);
  try {
    return await promise;
  } finally {
    pendingTemplateCreation.delete(key);
  }
}

/**
 * Insert a <effect-application> tray offering `effectDoc` into a chat
 * message's HTML, once. Explicitly marks it `visible` right after
 * connecting: dnd5e's ChatLog5e only wires live target-list updates
 * (EffectApplicationElement#shouldBuildTargetList requires both `open` AND
 * `visible`) through a one-shot MutationObserver on `.chat-log` that starts
 * observing a message's own `<li>` for IntersectionObserver visibility the
 * moment that `<li>` is FIRST added to the log (dnd5e.mjs:70089-70094,
 * #onLogMutated -> #intersections.observe(node)) — it does not re-scan for
 * elements injected into an already-observed message later. Because this
 * tray is injected asynchronously (after ensureEffectTemplate's possible DB
 * round-trip), it reliably misses that window, so `visible` never gets set
 * natively and the target list silently never builds, even after the user
 * opens the tray. Setting `.visible = true` ourselves — the same thing
 * dnd5e's own IntersectionObserver callback would do (dnd5e.mjs:70076-70081)
 * — reproduces that missed step; the tray is genuinely on-screen when this
 * runs, so this isn't a lie.
 */
export function injectEffectApplicationTray(html, effectDoc) {
  if (!effectDoc) return;
  const container = html.querySelector(".message-content");
  if (!container || container.querySelector("effect-application")) return;
  const el = document.createElement("effect-application");
  el.effects = [effectDoc];
  // Anchor before whichever trailing card element is present: a damage
  // roll's own <damage-application> (a direct child of .message-content),
  // or — for a bare item card (item-card.hbs) — its property-tags row
  // (.card-footer.pills, nested inside .chat-card, not .message-content
  // itself), so the tray lands above the tags rather than below the whole
  // card. Falls back to appending when neither is present.
  const anchor = container.querySelector("damage-application") ?? container.querySelector(".card-footer.pills");
  if (anchor) anchor.parentElement.insertBefore(el, anchor);
  else container.appendChild(el);
  el.visible = true;
}
