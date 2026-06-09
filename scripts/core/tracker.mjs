import { getTimers, remainingRounds, effInit } from "./store.mjs";
import { isWriter, removeTimers, setTimerInitiative, removeEffect, setTimerRounds, setEffectRounds } from "./socket.mjs";
import { getAdapter } from "../adapter/index.mjs";
import { collectEffects } from "./effects.mjs";

const ROW_CLASS = "cst-timer-row";
const BLOCK_CLASS = "cst-effects-block";

/**
 * Combatant ids whose effect panel is expanded. Kept in memory so the open/closed
 * state survives the tracker's frequent re-renders (advancing turns, edits, …).
 * @type {Set<string>}
 */
const expandedCombatants = new Set();

const esc = (s) => foundry.utils.escapeHTML?.(s ?? "") ?? (s ?? "");

/**
 * True if the current user may manually remove the given timer — either the
 * active GM or the owner of the casting actor.
 * @param {object} t  Timer record.
 * @returns {boolean}
 */
function canControl(t) {
  if (isWriter()) return true;
  const actor = fromUuidSync(t.casterActorUuid);
  return actor?.isOwner ?? false;
}

/**
 * Apply an edit from a row's initiative input to the timer. Mirrors the core
 * tracker's parsing: `+N`/`-N` adjust relative to the current value, a leading
 * `=` or a bare number sets an absolute value, and an empty field clears it.
 * @param {Event} ev          The input's change event.
 * @param {object} t          Timer record being edited.
 * @param {string} combatId   Id of the combat this row belongs to.
 */
function onEditInitiative(ev, t, combatId) {
  const raw = ev.target.value;
  const isDelta = /^[+-]/.test(raw);
  let next;
  if (!isDelta || raw[0] === "=") {
    next = raw ? Number(raw.replace(/^=/, "")) : null;
  } else {
    const delta = parseInt(raw, 10);
    if (Number.isNaN(delta)) return;
    next = (t.initiative ?? 0) + delta;
  }
  if (next !== null && Number.isNaN(next)) return;
  setTimerInitiative(combatId, t.id, next);
}

/**
 * Build a tracker row element for one spell timer, mimicking a combatant row.
 * The row carries an editable initiative input (like a real combatant) and a
 * single rounds-remaining sub-line; the caster is shown in the title in
 * parentheses. Removal is handled by the context menu. Feature timers are not
 * rendered as rows — they live in their owner's effect panel instead.
 * @param {object} t           Spell timer record.
 * @param {number} remaining   Rounds left (>0).
 * @param {string} combatId    Id of the combat this row belongs to.
 * @param {string} casterName  Displayed name of the caster as shown in the tracker.
 * @returns {HTMLLIElement}
 */
function buildRow(t, remaining, combatId, casterName) {
  const li = document.createElement("li");
  li.className = `combatant ${ROW_CLASS}`;
  li.dataset.cstTimerId = t.id;
  const escapedSpell = esc(t.name);
  const escapedCaster = esc(casterName);
  const title = escapedCaster ? `${escapedSpell} (${escapedCaster})` : escapedSpell;
  const editable = canControl(t);
  const initValue = t.initiative ?? "";
  const initiativeCell = `<div class="token-initiative">
      <input type="text" class="initiative-input cst-initiative-input" inputmode="numeric" pattern="^[+=\\-]?\\d*"
             value="${initValue}" aria-label="${game.i18n.localize("COMBAT.InitiativeScore")}" ${editable ? "" : "readonly"}>
    </div>`;
  li.innerHTML = `
    <img class="token-image" src="${t.img}" alt="${escapedSpell}" loading="lazy">
    <div class="token-name">
      <strong class="name">${title}</strong>
      <div class="cst-sub cst-remaining">${game.i18n.format("COMBAT_SPELL_TIMER.RoundsLeft", { n: remaining })}</div>
    </div>
    ${initiativeCell}
  `;
  if (editable) {
    const input = li.querySelector(".cst-initiative-input");
    input?.addEventListener("change", (ev) => onEditInitiative(ev, t, combatId));
  }
  // Our own right-click menu (replaces the core combatant menu on this row).
  li.addEventListener("contextmenu", (ev) => openTimerMenu(ev, t, combatId));
  return li;
}

/**
 * Build the in-row effects block appended below a combatant's normal content:
 * a divider, a left-aligned icon strip (each icon with its rounds remaining in
 * parentheses when known) and a right-aligned chevron that toggles a detail
 * panel. The panel lists only effects with a live countdown.
 * @param {HTMLLIElement} li         The combatant row.
 * @param {string} combatantId       Id of the combatant the row represents.
 * @param {Array<object>} effects    Result of collectEffects().
 * @param {string} combatId          Id of the combat this row belongs to.
 */
function buildEffectsBlock(li, combatantId, effects, combatId) {
  li.classList.add("cst-has-effects"); // CSS hides the core .token-effects on this row

  const strip = effects.map(e => {
    const count = e.remaining != null ? ` <span class="cst-effects-count">(${e.remaining})</span>` : "";
    return `<span class="cst-effects-icon"><img src="${e.img}" alt="${esc(e.name)}" loading="lazy">${count}</span>`;
  }).join("");

  const cards = effects.filter(e => e.expandable).map(e => {
    const name = e.source
      ? game.i18n.format("COMBAT_SPELL_TIMER.NameWithSource", { name: esc(e.name), source: esc(e.source) })
      : esc(e.name);
    const castLine = e.castRound != null
      ? `<div class="cst-sub">${game.i18n.format("COMBAT_SPELL_TIMER.CastRound", { round: e.castRound })}</div>`
      : "";
    // Each card carries its effect uuid so the right-click remove menu can be
    // wired below (replacing the core combatant menu on that card).
    return `
      <div class="cst-effect-card" data-cst-effect-uuid="${esc(e.effectUuid)}">
        <img class="cst-effect-img" src="${e.img}" alt="${esc(e.name)}" loading="lazy">
        <div class="cst-effect-info">
          <strong class="name">${name}</strong>
          ${castLine}
          <div class="cst-sub cst-remaining">${game.i18n.format("COMBAT_SPELL_TIMER.RoundsLeft", { n: e.remaining })}</div>
        </div>
      </div>`;
  }).join("");

  const expandable = cards.length > 0;
  const expanded = expandable && expandedCombatants.has(combatantId);
  const chevron = expanded ? "fa-chevron-up" : "fa-chevron-down";
  const toggle = expandable
    ? `<button type="button" class="cst-effects-toggle" aria-label="${game.i18n.localize("COMBAT_SPELL_TIMER.ToggleEffects")}" aria-expanded="${expanded}">
        <i class="fa-solid ${chevron}"></i>
      </button>`
    : "";

  const block = document.createElement("div");
  block.className = BLOCK_CLASS;
  block.innerHTML = `
    <div class="cst-effects-row">
      <div class="cst-effects-strip">${strip}</div>
      ${toggle}
    </div>
    ${expandable ? `<div class="cst-effects-panel" ${expanded ? "" : "hidden"}>${cards}</div>` : ""}
    <hr class="cst-effects-divider">
  `;

  if (expandable) {
    // Clicking anywhere on the strip row (not just the chevron) toggles the panel.
    const row = block.querySelector(".cst-effects-row");
    const btn = block.querySelector(".cst-effects-toggle");
    const panel = block.querySelector(".cst-effects-panel");
    const icon = btn.querySelector("i");
    row.classList.add("cst-clickable");
    row.addEventListener("click", () => {
      const open = panel.hasAttribute("hidden");
      if (open) { panel.removeAttribute("hidden"); expandedCombatants.add(combatantId); }
      else { panel.setAttribute("hidden", ""); expandedCombatants.delete(combatantId); }
      btn.setAttribute("aria-expanded", String(open));
      icon.classList.toggle("fa-chevron-down", !open);
      icon.classList.toggle("fa-chevron-up", open);
    });
  }

  // Every expanded card gets our own right-click menu, suppressing the core
  // combatant menu on these entries (and showing nothing for users who can't
  // remove the effect — see openEffectMenu / collectEffects controllable). Cards
  // render in the same order as the expandable effects, so zip them by index.
  const cardEls = block.querySelectorAll(".cst-effect-card");
  const expandableEffects = effects.filter(e => e.expandable);
  cardEls.forEach((card, i) => {
    const e = expandableEffects[i];
    if (e) card.addEventListener("contextmenu", (ev) => openEffectMenu(ev, e, combatId));
  });
  li.appendChild(block);
}

/**
 * Insert a timer row at its own initiative position in the tracker. A row with
 * a set initiative is placed above every combatant ranked at or below it — i.e.
 * before the first combatant tied at (or lower than) its initiative — so it sits
 * above combatants sharing its initiative. A row still without an initiative
 * falls back to sitting beneath its owner's row. Rows are inserted in
 * descending-initiative order by the caller, so several rows landing in the same
 * gap stay correctly ordered relative to each other.
 * @param {HTMLOListElement} ol  The tracker list.
 * @param {Combat} combat
 * @param {object} t             Timer record.
 * @param {HTMLLIElement} row    The row element to place.
 */
function placeRow(ol, combat, t, row) {
  if (t.initiative == null) {
    const ownerLi = ol.querySelector(`li.combatant[data-combatant-id="${t.casterCombatantId}"]`);
    if (ownerLi) ownerLi.insertAdjacentElement((t.anchorToOwner ?? false) ? "beforebegin" : "afterend", row);
    else ol.appendChild(row); // owner row not visible (e.g. hidden NPC) → fall back to end
    return;
  }
  const below = combat.turns.find(c => effInit(c) <= t.initiative);
  const belowLi = below ? ol.querySelector(`li.combatant[data-combatant-id="${below.id}"]`) : null;
  if (belowLi) belowLi.insertAdjacentElement("beforebegin", row);
  else ol.appendChild(row); // ranks below every combatant → end of the list
}

/**
 * renderCombatTracker handler. Clears our prior rows, then inserts a fresh row
 * for each timer at its own initiative slot. `element` is HTMLElement on both
 * v13 and v14.
 * @param {Application} app
 * @param {HTMLElement} element
 */
export function onRenderTracker(app, element) {
  // The hook also fires for the popout; handle whichever element we got.
  element.querySelectorAll(`.${ROW_CLASS}, .${BLOCK_CLASS}`).forEach(n => n.remove()); // avoid duplicates on partial renders

  const combat = app.viewed;
  if (!combat) return;
  const ol = element.querySelector("ol.combat-tracker");
  if (!ol) return;

  // Spell rows only: feature timers (Rage, …) now live in their owner's effect
  // panel rather than as a standalone row. Descending by initiative so multiple
  // rows in one gap keep their order; null-initiative rows sort last.
  const timers = [...getTimers(combat)]
    .filter(t => !getAdapter().getFeatureView(t.type)) // drop feature timers
    .sort((a, b) => (b.initiative ?? -Infinity) - (a.initiative ?? -Infinity));
  for (const t of timers) {
    const remaining = remainingRounds(t, combat);
    if (remaining <= 0) continue; // expired rows are pruned by the GM; never render them
    // Read the caster name exactly as shown in their row (respects hidden-name rules).
    const ownerLi = ol.querySelector(`li.combatant[data-combatant-id="${t.casterCombatantId}"]`);
    const casterName = ownerLi?.querySelector(".name")?.textContent?.trim()
      ?? combat.combatants.get(t.casterCombatantId)?.name ?? "";
    const row = buildRow(t, remaining, combat.id, casterName);
    placeRow(ol, combat, t, row);
  }

  // Fold each combatant's temporary effects into its own row.
  for (const cli of ol.querySelectorAll("li.combatant[data-combatant-id]")) {
    const combatant = combat.combatants.get(cli.dataset.combatantId);
    if (!combatant) continue;
    const effects = collectEffects(combatant, combat);
    if (effects.length) buildEffectsBlock(cli, combatant.id, effects, combat.id);
    else expandedCombatants.delete(combatant.id); // forget stale expand state
  }
}

/**
 * The currently open timer context menu, if any: its element plus the document
 * listeners that dismiss it. Only one is ever open at a time.
 * @type {{el: HTMLElement, onAway: Function, onKey: Function}|null}
 */
let openMenu = null;

/** Close and fully tear down the open timer context menu, if any. */
function closeTimerMenu() {
  if (!openMenu) return;
  openMenu.el.remove();
  document.removeEventListener("pointerdown", openMenu.onAway, true);
  document.removeEventListener("keydown", openMenu.onKey, true);
  window.removeEventListener("blur", closeTimerMenu);
  openMenu = null;
}

/**
 * Build and show our right-click menu at the cursor. Reuses Foundry's
 * #context-menu markup so its native styling applies verbatim.
 * @param {MouseEvent} event   The triggering contextmenu event.
 * @param {Array<{icon:string, label:string, onClick:() => void}>} items
 */
function showContextMenu(event, items) {
  if (!items.length) return;
  const nav = document.createElement("nav");
  nav.id = "context-menu";
  nav.className = "cst-timer-menu";
  nav.innerHTML = `
    <ol class="context-items">
      ${items.map(i => `<li class="context-item"><i class="fa-solid ${i.icon} fa-fw"></i><span>${esc(i.label)}</span></li>`).join("")}
    </ol>`;
  nav.querySelectorAll(".context-item").forEach((li, idx) => {
    li.addEventListener("click", () => {
      items[idx].onClick();
      closeTimerMenu();
    });
  });
  document.body.append(nav);

  // Position at the cursor, nudging back inside the viewport if it would overflow.
  const rect = nav.getBoundingClientRect();
  const left = Math.max(4, Math.min(event.clientX, window.innerWidth - rect.width - 4));
  const top = Math.max(4, Math.min(event.clientY, window.innerHeight - rect.height - 4));
  nav.style.left = `${left}px`;
  nav.style.top = `${top}px`;

  const onAway = (e) => { if (!nav.contains(e.target)) closeTimerMenu(); };
  const onKey = (e) => { if (e.key === "Escape") closeTimerMenu(); };
  openMenu = { el: nav, onAway, onKey };
  // Defer so the opening right-click's own events don't immediately dismiss it.
  setTimeout(() => {
    document.addEventListener("pointerdown", onAway, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", closeTimerMenu);
  }, 0);
}

/**
 * Suppress the core combatant menu for one of our entries — always, so a user
 * with no available actions gets no menu at all (rather than the combatant one).
 * @param {MouseEvent} event
 */
function claimContextMenu(event) {
  event.preventDefault();
  event.stopPropagation();   // keep the core combatant menu off our entries
  ui.context?.close?.();     // dismiss any native combatant menu still open
  closeTimerMenu();          // only one of ours open at a time
}

/**
 * Open the GM "Update Effect" dialog for an entry: a single rounds-left number
 * input with Cancel / Update. On Update, `apply(rounds)` performs the write.
 * @param {string} name           Effect/spell name (for the title).
 * @param {number} currentRounds  Pre-filled current rounds remaining.
 * @param {(rounds:number) => void} apply
 */
function openUpdateDialog(name, currentRounds, apply) {
  new foundry.applications.api.DialogV2({
    window: { title: game.i18n.format("COMBAT_SPELL_TIMER.UpdateTitle", { name }), icon: "fa-solid fa-pen-to-square" },
    content: `
      <label class="cst-existing-rounds">
        ${game.i18n.localize("COMBAT_SPELL_TIMER.RoundsRemaining")}
        <input type="number" name="rounds" value="${Number(currentRounds) || 1}" min="1" step="1" autofocus>
      </label>`,
    buttons: [
      {
        action: "update",
        icon: "fa-solid fa-check",
        label: game.i18n.localize("COMBAT_SPELL_TIMER.Update"),
        default: true,
        callback: (_event, button) => {
          const n = parseInt(button.form.elements.rounds.value, 10);
          if (Number.isInteger(n) && n >= 1) apply(n);
        },
      },
    ],
  }).render({ force: true });
}

/**
 * Right-click menu for a spell timer row.
 * @param {MouseEvent} event   The row's contextmenu event.
 * @param {object} t           Spell timer record.
 * @param {string} combatId    Id of the combat this row belongs to.
 */
function openTimerMenu(event, t, combatId) {
  claimContextMenu(event);
  const items = [];
  if (game.user.isGM) {
    items.push({
      icon: "fa-pen-to-square",
      label: game.i18n.localize("COMBAT_SPELL_TIMER.UpdateEffect"),
      onClick: () => openUpdateDialog(t.name, remainingRounds(t, game.combats.get(combatId)),
        n => setTimerRounds(combatId, t.id, n)),
    });
  }
  if (canControl(t)) {
    const view = getAdapter().getFeatureView(t.type);
    // Uniform with features ("End Rage"): spells read "End <spell>".
    const label = view?.removeLabelKey
      ? game.i18n.localize(view.removeLabelKey)
      : game.i18n.format("COMBAT_SPELL_TIMER.EndSpell", { name: t.name });
    items.push({
      icon: "fa-trash",
      label,
      onClick: () => {
        removeTimers(combatId, { id: t.id });
        getAdapter().onManualRemove(t); // ends concentration on the caster
      },
    });
  }
  showContextMenu(event, items);
}

/**
 * Right-click menu for an expanded effect-panel card. Feature effects remove via
 * their timer (ending the feature); all other effects delete the ActiveEffect.
 * Shows nothing for users who can't control the effect (but still suppresses the
 * core combatant menu).
 * @param {MouseEvent} event   The card's contextmenu event.
 * @param {object} e           Effect entry from collectEffects().
 * @param {string} combatId    Id of the combat this row belongs to.
 */
function openEffectMenu(event, e, combatId) {
  claimContextMenu(event);
  const items = [];
  if (game.user.isGM) {
    // Update the source that drives the count: the linked timer if any, else the AE.
    const apply = e.countdownTimerId
      ? (n) => setTimerRounds(combatId, e.countdownTimerId, n)
      : (n) => setEffectRounds(e.effectUuid, n);
    items.push({
      icon: "fa-pen-to-square",
      label: game.i18n.localize("COMBAT_SPELL_TIMER.UpdateEffect"),
      onClick: () => openUpdateDialog(e.name, e.remaining, apply),
    });
  }
  if (e.controllable) {
    if (e.timer) {
      const view = getAdapter().getFeatureView(e.timer.type);
      const label = game.i18n.localize(view?.removeLabelKey ?? "COMBAT_SPELL_TIMER.RemoveSpellTimer");
      items.push({
        icon: "fa-trash",
        label,
        onClick: () => { removeTimers(combatId, { id: e.timer.id }); getAdapter().onManualRemove(e.timer); },
      });
    } else {
      items.push({
        icon: "fa-trash",
        label: game.i18n.format("COMBAT_SPELL_TIMER.RemoveEffect", { name: e.name }),
        onClick: () => removeEffect(e.effectUuid),
      });
    }
  }
  showContextMenu(event, items);
}
