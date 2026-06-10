import { MODULE_ID } from "../module.mjs";
import { dbg } from "../utils/debug.mjs";
import { getAdapter } from "../adapter/index.mjs";
import { resolveMappedName } from "./spell-map.mjs";
import { onFeatureStart } from "./features.mjs";

/** Beyond20 request types that represent a spell being cast. */
const SPELL_TYPES = new Set(["spell-card", "spell-attack"]);

/** Module flag key under which the captured cast context is stored on a message. */
export const FLAG = "beyond20";

/** Setting key (registered in the entry point) gating the whole integration. */
export const SETTING = "beyond20Integration";

/**
 * Setting key for the per-player "do it automatically instead of clicking"
 * option. Governs both auto-casting spells and auto-applying feature effects
 * (e.g. Rage) — one switch for every Beyond20 card.
 */
export const AUTOCAST_SETTING = "beyond20AutoCast";

/**
 * Beyond20 "trait" cards this module offers a one-click activation button for,
 * keyed by the lowercased D&D Beyond trait name.
 *  - mode "feature": start a module-managed feature (its AE + combat timer),
 *    routed through the feature registry — e.g. Rage.
 *  - mode "use": trigger the actor's own item in Foundry so the system shows its
 *    native dialog and applies its effect; the module adds no tracking — e.g.
 *    Bolstering Magic.
 */
const TRAIT_ACTIONS = {
  "rage": {
    mode: "feature", featureId: "rage",
    btnClass: "cst-beyond20-rage",
    icon: "fa-solid fa-fire",
    labelKey: "COMBAT_SPELL_TIMER.Beyond20.StartRage",
  },
  "bolstering magic": {
    mode: "use", itemName: "Bolstering Magic",
    btnClass: "cst-beyond20-bolstering-magic",
    icon: "fa-solid fa-hand-sparkles",
    labelKey: "COMBAT_SPELL_TIMER.Beyond20.UseBolsteringMagic",
  },
};

/** Module flag: the lowercased trait key a Beyond20 trait card was matched to. */
export const TRAIT_FLAG = "beyond20-trait";

/** Look up the action for a Beyond20 trait request, or null. */
function traitActionFor(request) {
  if (request?.type !== "trait") return null;
  return TRAIT_ACTIONS[request.name?.toLowerCase()] ?? null;
}

/** True when the Beyond20 integration setting is enabled for this client. */
function enabled() {
  return game.settings?.settings?.has(`${MODULE_ID}.${SETTING}`)
    && game.settings.get(MODULE_ID, SETTING);
}

/**
 * True when this client wants Beyond20 cards resolved automatically on render —
 * casting spells and applying feature effects alike, instead of clicking.
 */
function autoEnabled() {
  return enabled()
    && game.settings.settings.has(`${MODULE_ID}.${AUTOCAST_SETTING}`)
    && game.settings.get(MODULE_ID, AUTOCAST_SETTING);
}

/**
 * Cast contexts captured from `beyond20Request`, awaiting their chat message.
 * Beyond20 fires the hook immediately before creating the message on the same
 * client, so this short FIFO is matched by exact raw-HTML equality in
 * preCreateChatMessage. Entries are time-stamped so stale ones (no message ever
 * created, e.g. the request had sendMessage off) can be pruned.
 * @type {{html: string, ctx: {name: string, level: number, type: string}, at: number}[]}
 */
const pending = [];
const MAX_AGE_MS = 10_000;

/** Drop pending entries older than MAX_AGE_MS so the queue can't grow unbounded. */
function prunePending(now) {
  for (let i = pending.length - 1; i >= 0; i--) {
    if (now - pending[i].at > MAX_AGE_MS) pending.splice(i, 1);
  }
}

/** Pending Beyond20 trait cards awaiting their chat message; stores the match key. */
const traitPending = [];

function pruneTraitPending(now) {
  for (let i = traitPending.length - 1; i >= 0; i--) {
    if (now - traitPending[i].at > MAX_AGE_MS) traitPending.splice(i, 1);
  }
}

/**
 * Derive the cast (slot) level from a Beyond20 request, matching Beyond20's own
 * logic: the upcast level when `cast-at` is present, else the spell's printed
 * level, else 0 for cantrips. parseInt copes with "2nd"/"1st Level Enchantment".
 * @param {object} request
 * @returns {number}
 */
function castLevel(request) {
  return parseInt(request["cast-at"] || request["level-school"]) || 0;
}

/**
 * beyond20Request handler. The Beyond20 extension (or module) fires this as
 * Hooks.callAll("beyond20Request", action, data). For a rendered spell card/attack
 * we stash the spell name + cast level keyed by the raw HTML Beyond20 will use as
 * the message content, to be attached in preCreateChatMessage.
 * @param {string} action  e.g. "rendered-roll".
 * @param {object} data    The full Beyond20 payload (has .request and .html).
 */
export function onBeyond20Request(action, data) {
  if (!enabled()) return;
  const request = data?.request;
  if (!request) return;
  if (typeof data.html !== "string") return;
  const now = Date.now();

  if (SPELL_TYPES.has(request.type)) {
    const ctx = { name: request.name, level: castLevel(request), type: request.type };
    prunePending(now);
    pending.push({ html: data.html, ctx, at: now });
    dbg("beyond20:request", ctx.name, `lvl ${ctx.level}`, ctx.type);
  } else {
    const action = traitActionFor(request);
    if (action) {
      pruneTraitPending(now);
      traitPending.push({ html: data.html, match: request.name.toLowerCase(), at: now });
      dbg("beyond20:trait-request", request.name);
    }
  }
}

/**
 * preCreateChatMessage handler. Beyond20 sets the message content to the exact raw
 * HTML it passed in the request (before Foundry sanitizes it), so we match a
 * pending entry by string equality and persist its cast context as a module flag.
 * Writing the flag here (pre-persist) means it syncs to every client and survives
 * reloads, so the button can render anywhere without re-matching.
 * @param {ChatMessage} message  The document being created.
 * @param {object} data          The raw creation data (data.content === raw html).
 */
export function onPreCreateBeyond20Message(message, data) {
  if (!enabled() || (!pending.length && !traitPending.length)) return;
  const content = typeof data?.content === "string" ? data.content : message?.content;
  if (typeof content !== "string") return;

  if (pending.length) {
    const idx = pending.findIndex(p => p.html === content);
    if (idx !== -1) {
      const { ctx } = pending.splice(idx, 1)[0];
      message.updateSource({ flags: { [MODULE_ID]: { [FLAG]: ctx } } });
      dbg("beyond20:flag", ctx.name, `lvl ${ctx.level}`);
    }
  }

  if (traitPending.length) {
    const idx = traitPending.findIndex(p => p.html === content);
    if (idx !== -1) {
      const { match } = traitPending.splice(idx, 1)[0];
      message.updateSource({ flags: { [MODULE_ID]: { [TRAIT_FLAG]: match } } });
      dbg("beyond20:trait-flag", match);
    }
  }
}

/** Marker class so the cast-spell button is never injected twice on re-render. */
const BTN_CLASS = "cst-beyond20-cast";

/**
 * Message ids already auto-cast on this client. renderChatMessageHTML fires more
 * than once per message (chat log + the transient notification), so this guards
 * against auto-casting the same card twice on a single client.
 * @type {Set<string>}
 */
const autoCastDone = new Set();

/** Message ids for which a trait was already auto-activated on this client. */
const autoTraitDone = new Set();

/**
 * True if the current user may cast this message's spell — the active GM, or an
 * owner of the speaking actor (so a player can spend their own slot).
 * @param {ChatMessage} message
 * @param {Actor|null} actor
 * @returns {boolean}
 */
function canCast(message, actor) {
  return !!game.user?.isGM || (actor?.isOwner ?? false);
}

/**
 * Cast a flagged Beyond20 card's spell: resolve the speaking actor and delegate
 * to the active system adapter. Re-checks the integration setting (the card may
 * outlive a toggle-off). Returns the adapter result, or null if nothing was cast.
 * @param {ChatMessage} message
 * @param {{name: string, level: number}} ctx  The captured cast context.
 * @returns {Promise<object|null>}
 */
async function castFromMessage(message, ctx) {
  if (!enabled()) return null;
  // `speakerActor` is the instance getter (token actor → explicit actor →
  // author's character); `getSpeakerActor` is static-only, so don't call it here.
  const actor = message.speakerActor ?? null;
  if (!actor) {
    ui.notifications?.warn(game.i18n.localize("COMBAT_SPELL_TIMER.Beyond20.NoActor"));
    return null;
  }
  // Run the D&D Beyond name through the GM's mapping before looking it up.
  const name = resolveMappedName(ctx.name);
  return getAdapter().castSpell(actor, { name, level: ctx.level });
}

/**
 * Resolve the speaking actor from a chat message and start a feature by id.
 * Feature-agnostic: asks the active adapter for a start record (it knows the
 * item lookup + edition-aware duration) instead of hand-building one, then runs
 * the same generic start path as the hook-based detection.
 * @param {ChatMessage} message
 * @param {string} featureId
 * @returns {Promise<boolean>}  true on success, false if the actor/record was unavailable.
 */
async function startFeatureFromMessage(message, featureId) {
  if (!enabled()) return false;
  const actor = message.speakerActor ?? null;
  if (!actor) {
    ui.notifications?.warn(game.i18n.localize("COMBAT_SPELL_TIMER.Beyond20.NoActor"));
    return false;
  }
  const record = getAdapter().getFeatureStartRecord(actor, featureId);
  if (!record) return false;
  dbg("beyond20:feature-start", featureId, actor.name);
  await onFeatureStart(record, (a, fid, opts) => getAdapter().applyFeatureEffect(a, fid, opts));
  return true;
}

/** Run a matched Beyond20 trait card's action (module feature, or native item use). */
async function runTraitAction(message, action) {
  if (action.mode === "feature") return startFeatureFromMessage(message, action.featureId);
  if (action.mode === "use")     return useFeatureFromMessage(message, action.itemName);
  return false;
}

/**
 * Activate one of the speaking actor's own items by name in Foundry (dnd5e shows
 * its dialog and applies the effect). For Beyond20 traits the module doesn't manage.
 * @param {ChatMessage} message
 * @param {string} itemName
 * @returns {Promise<boolean>}
 */
async function useFeatureFromMessage(message, itemName) {
  if (!enabled()) return false;
  const actor = message.speakerActor ?? null;
  if (!actor) {
    ui.notifications?.warn(game.i18n.localize("COMBAT_SPELL_TIMER.Beyond20.NoActor"));
    return false;
  }
  dbg("beyond20:use-feature", itemName, actor.name);
  const result = await getAdapter().useFeature(actor, { name: itemName });
  return !!result;
}

/**
 * renderChatMessageHTML handler (v13+; `html` is an HTMLElement). When the message
 * carries a captured Beyond20 cast context and the user may cast it, append a
 * "Cast Spell" button below the card, wired to the active system adapter. The
 * button is placed at the bottom of the message content (below the description and
 * any roll results) so it stays visible whether the card's <details> is open or
 * closed.
 *
 * With the per-player auto-cast setting on, the button is shown disabled (an
 * indicator only) and the cast runs automatically — but only on the message
 * author's client, so the same spell isn't cast once per client that could cast
 * it (GM + owner).
 * @param {ChatMessage} message
 * @param {HTMLElement} html
 */
export function onRenderBeyond20Message(message, html) {
  if (!enabled()) return;
  const ctx = message.getFlag(MODULE_ID, FLAG);
  const traitKey = message.getFlag(MODULE_ID, TRAIT_FLAG);
  const action = traitKey ? TRAIT_ACTIONS[traitKey] : null;
  if (!ctx && !action) return;

  const card = html.querySelector(".beyond20-message");
  if (!card) return;
  // Place below the whole card (spell-attack appends roll-result siblings after
  // .beyond20-message), and dedupe per rendered element.
  const container = card.closest(".message-content") ?? card.parentElement ?? card;

  // --- Spell "Cast Spell" button ---
  if (ctx && !container.querySelector(`.${BTN_CLASS}`)) {
    const actor = message.speakerActor ?? null;
    if (canCast(message, actor)) {
      const auto = autoEnabled();
      const wrap = document.createElement("div");
      wrap.className = "cst-beyond20-controls";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = BTN_CLASS;
      btn.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i> ${game.i18n.localize("COMBAT_SPELL_TIMER.Beyond20.CastSpell")}`;

      if (auto) {
        btn.disabled = true;
        if (message.isAuthor && !autoCastDone.has(message.id)) {
          autoCastDone.add(message.id);
          dbg("beyond20:auto-cast", ctx.name);
          castFromMessage(message, ctx);
        }
      } else {
        btn.addEventListener("click", async () => {
          if (!enabled()) return;
          btn.disabled = true;
          const result = await castFromMessage(message, ctx);
          if (!result) btn.disabled = false;
        });
      }

      wrap.appendChild(btn);
      container.appendChild(wrap);
      dbg("beyond20:button", ctx.name, auto ? "auto" : "manual");
    }
  }

  // --- Generic trait activation button (replaces the Rage-only block) ---
  if (action && !container.querySelector(`.${action.btnClass}`)) {
    const actor = message.speakerActor ?? null;
    if (canCast(message, actor)) {
      const auto = autoEnabled();
      const wrap = document.createElement("div");
      wrap.className = "cst-beyond20-controls";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = action.btnClass;
      btn.innerHTML = `<i class="${action.icon}"></i> ${game.i18n.localize(action.labelKey)}`;

      if (auto) {
        btn.disabled = true;
        if (message.isAuthor && !autoTraitDone.has(message.id)) {
          autoTraitDone.add(message.id);
          dbg("beyond20:auto-trait", traitKey);
          runTraitAction(message, action);
        }
      } else {
        btn.addEventListener("click", async () => {
          if (!enabled()) return;
          btn.disabled = true;
          const ok = await runTraitAction(message, action);
          if (!ok) btn.disabled = false;
        });
      }

      wrap.appendChild(btn);
      container.appendChild(wrap);
      dbg("beyond20:trait-button", traitKey, auto ? "auto" : "manual");
    }
  }
}

/**
 * Register the Beyond20 chat integration hooks. Called once on ready. Handlers
 * self-gate on the client setting so toggling it takes effect for new messages
 * without a reload.
 */
export function registerBeyond20Integration() {
  Hooks.on("beyond20Request", onBeyond20Request);
  Hooks.on("preCreateChatMessage", onPreCreateBeyond20Message);
  Hooks.on("renderChatMessageHTML", onRenderBeyond20Message);
}
