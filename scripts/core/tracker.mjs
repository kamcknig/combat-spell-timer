import { MODULE_ID } from "../module.mjs";
import { getTimers, remainingRounds, effInit } from "./store.mjs";
import { isWriter, removeTimers, setTimerInitiative } from "./socket.mjs";
import { getAdapter } from "../adapter/index.mjs";

const ROW_CLASS = "cst-timer-row";

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
 * Build a tracker row element for one timer, mimicking a combatant row. The
 * row carries an editable initiative input (like a real combatant) and shows
 * the rounds remaining as a sub-line; removal is handled by the context menu.
 * @param {object} t           Timer record.
 * @param {number} remaining   Rounds left (>0).
 * @param {string} combatId    Id of the combat this row belongs to.
 * @param {string} casterName  Displayed name of the caster as shown in the tracker.
 * @returns {HTMLLIElement}
 */
function buildRow(t, remaining, combatId, casterName) {
  const li = document.createElement("li");
  li.className = `combatant ${ROW_CLASS}`;
  li.dataset.cstTimerId = t.id;
  if (t.type) li.dataset.cstType = t.type;
  const escapedSpell = foundry.utils.escapeHTML?.(t.name) ?? t.name;
  const escapedCaster = foundry.utils.escapeHTML?.(casterName) ?? casterName;
  const editable = canControl(t);
  const view = getAdapter().getFeatureView(t.type);   // null for spells
  const anchored = t.anchorToOwner ?? false;
  const roundsKey = view?.roundsLeftKey ?? "COMBAT_SPELL_TIMER.RoundsLeft";
  const initValue = t.initiative ?? "";
  const initiativeCell = anchored
    ? `<div class="token-initiative"></div>`
    : `<div class="token-initiative">
      <input type="text" class="initiative-input cst-initiative-input" inputmode="numeric" pattern="^[+=\\-]?\\d*"
             value="${initValue}" aria-label="${game.i18n.localize("COMBAT.InitiativeScore")}" ${editable ? "" : "readonly"}>
    </div>`;
  li.innerHTML = `
    <img class="token-image" src="${t.img}" alt="${escapedSpell}" loading="lazy">
    <div class="token-name">
      <strong class="name">${escapedSpell}</strong>
      <div class="cst-sub">${escapedCaster}</div>
      <div class="cst-sub">${game.i18n.format("COMBAT_SPELL_TIMER.CastRound", { round: t.castRound })}</div>
      <div class="cst-sub cst-remaining">${game.i18n.format(roundsKey, { n: remaining })}</div>
    </div>
    ${initiativeCell}
  `;
  if (editable && !anchored) {
    const input = li.querySelector(".cst-initiative-input");
    input?.addEventListener("change", (ev) => onEditInitiative(ev, t, combatId));
  }
  // Our own right-click menu (replaces the core combatant menu on this row).
  li.addEventListener("contextmenu", (ev) => openTimerMenu(ev, t, combatId));
  return li;
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
  element.querySelectorAll(`.${ROW_CLASS}`).forEach(n => n.remove()); // avoid duplicates on partial renders

  const combat = app.viewed;
  if (!combat) return;
  const ol = element.querySelector("ol.combat-tracker");
  if (!ol) return;

  // Descending by initiative so multiple rows in one gap keep their order;
  // null-initiative rows (anchored to their owner) sort last.
  const timers = [...getTimers(combat)].sort((a, b) => (b.initiative ?? -Infinity) - (a.initiative ?? -Infinity));
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
 * Open our own right-click menu for a timer row and suppress the core combatant
 * menu. The core ContextMenu listens on the tracker container, so stopping
 * propagation here (the row is a descendant) prevents it — and any stale or
 * duplicate instance — from firing, which is why the menu is built by hand
 * rather than via the shared tracker context-options hook.
 * @param {MouseEvent} event   The row's contextmenu event.
 * @param {object} t           Timer record.
 * @param {string} combatId    Id of the combat this row belongs to.
 */
function openTimerMenu(event, t, combatId) {
  event.preventDefault();
  event.stopPropagation();   // keep the core combatant menu off our rows
  ui.context?.close?.();     // dismiss any native combatant menu still open
  closeTimerMenu();          // only one of ours open at a time
  if (!canControl(t)) return; // nothing actionable for this user

  // Reuse Foundry's #context-menu markup so its native styling applies verbatim.
  const nav = document.createElement("nav");
  nav.id = "context-menu";
  nav.className = "cst-timer-menu";
  const view = getAdapter().getFeatureView(t.type);
  const removeLabel = game.i18n.localize(view?.removeLabelKey ?? "COMBAT_SPELL_TIMER.RemoveSpellTimer");
  nav.innerHTML = `
    <ol class="context-items">
      <li class="context-item">
        <i class="fa-solid fa-trash fa-fw"></i><span>${removeLabel}</span>
      </li>
    </ol>`;
  nav.querySelector(".context-item").addEventListener("click", () => {
    removeTimers(combatId, { id: t.id });
    getAdapter().onManualRemove(t); // ends concentration on the caster
    closeTimerMenu();
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
