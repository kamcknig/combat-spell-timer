import { MODULE_ID } from "../module.mjs";
import { getSpellMap, setSpellMap } from "../core/spell-map.mjs";
import { getAdapter } from "../adapter/index.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * GM-only editor for the Beyond20 spell-name mapping. Renders one row per stored
 * { from, to } pair, each `to` field a custom combobox (text input + caret) with a
 * scrollable spell-name suggestion list. Rows are managed by direct DOM
 * manipulation (add/remove/clear) so unsaved edits survive, and saving reads the
 * live rows from the DOM. Opened from the settings-menu button.
 */
export default class SpellMapConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "combat-spell-timer-spell-map",
    tag: "form",
    classes: ["combat-spell-timer", "cst-spell-map"],
    window: {
      title: "COMBAT_SPELL_TIMER.Beyond20.SpellMap.Title",
      icon: "fa-solid fa-wand-magic-sparkles",
      resizable: true
    },
    position: { width: 560, height: "auto" },
    form: { handler: SpellMapConfig.#onSubmit, closeOnSubmit: true },
    actions: {
      addEntry: SpellMapConfig.#onAddEntry,
      removeEntry: SpellMapConfig.#onRemoveEntry,
      clearAll: SpellMapConfig.#onClearAll,
      toggleSuggest: SpellMapConfig.#onToggleSuggest
    }
  };

  static PARTS = {
    form: { template: "modules/combat-spell-timer/templates/spell-map-config.hbs" }
  };

  /** Max suggestion rows shown at once; type to narrow further. */
  static #MAX_SUGGEST = 100;

  /** Cached spell names for the suggestion list (fetched once per open). */
  #spellNames = null;

  /** Whether the delegated combobox/window listeners are bound. */
  #wired = false;

  /**
   * The shared suggestion dropdown, appended to <body> rather than inside the
   * window. The window is small and auto-sized, so an in-window dropdown is clipped
   * at the window's edge; a fixed, body-level element shows the full list.
   * @type {HTMLUListElement|null}
   */
  #suggestEl = null;

  /** The `to` input the dropdown is currently showing for, if any. */
  #activeInput = null;

  /**
   * Hide the dropdown on window resize, or on scrolling anything other than the
   * dropdown itself — scrolling the list (wheel or scrollbar) must not dismiss it.
   * @param {Event} [ev]
   */
  #onWindowChange = (ev) => {
    if (ev?.type === "scroll" && this.#suggestEl?.contains(ev.target)) return;
    this.#hideSuggest();
  };

  /**
   * Dismiss the dropdown when the user points down outside both it and its input.
   * Used instead of input-blur so clicking the list's scrollbar doesn't close it.
   * @param {PointerEvent} ev
   */
  #onDocPointerDown = (ev) => {
    if (!this.#suggestEl || this.#suggestEl.hidden) return;
    const t = ev.target;
    if (this.#suggestEl.contains(t)) return;
    if (this.#activeInput?.closest(".cst-map-combo")?.contains(t)) return;
    this.#hideSuggest();
  };

  /**
   * Build the render context (the stored rows) and cache the spell-name list for
   * the suggestion combobox. The adapter lookup is defensive — a failure just
   * yields a free-form-only field.
   * @param {object} _options
   * @returns {Promise<{entries: {from: string, to: string}[]}>}
   */
  async _prepareContext(_options) {
    if (this.#spellNames === null) {
      try { this.#spellNames = await getAdapter().listSpellNames(); }
      catch { this.#spellNames = []; }
    }
    return { entries: getSpellMap() };
  }

  /**
   * Bind delegated combobox listeners on the persistent form root, plus window
   * scroll/resize listeners that dismiss the (body-level) dropdown. Bound once.
   * @param {object} context
   * @param {object} options
   */
  _onRender(context, options) {
    super._onRender(context, options);
    if (this.#wired) return;
    this.#wired = true;
    const root = this.element;
    root.addEventListener("input", (ev) => {
      if (ev.target.classList?.contains("cst-map-to")) this.#showSuggest(ev.target);
    });
    root.addEventListener("focusin", (ev) => {
      if (ev.target.classList?.contains("cst-map-to")) this.#showSuggest(ev.target);
    });
    root.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && this.#suggestEl && !this.#suggestEl.hidden) {
        this.#hideSuggest();
        ev.preventDefault();
        ev.stopPropagation();
      }
    });
    document.addEventListener("pointerdown", this.#onDocPointerDown, true);
    window.addEventListener("scroll", this.#onWindowChange, true);
    window.addEventListener("resize", this.#onWindowChange);
  }

  /**
   * Lazily create the body-level dropdown and wire option selection on it.
   * @returns {HTMLUListElement}
   */
  #ensureSuggestEl() {
    if (this.#suggestEl) return this.#suggestEl;
    const ul = document.createElement("ul");
    ul.className = "cst-spell-map-suggestions";
    ul.hidden = true;
    // mousedown (not click) so it fires before the input's blur-driven hide.
    ul.addEventListener("mousedown", (ev) => {
      const li = ev.target.closest("li");
      if (!li || !this.#activeInput) return;
      ev.preventDefault(); // keep focus in the input
      this.#activeInput.value = li.textContent;
      this.#hideSuggest();
    });
    document.body.appendChild(ul);
    this.#suggestEl = ul;
    return ul;
  }

  /**
   * Populate, position and show the dropdown for a `to` input, filtered by its
   * current value (case-insensitive substring) and capped for responsiveness.
   * @param {HTMLInputElement} input
   */
  #showSuggest(input) {
    const ul = this.#ensureSuggestEl();
    const q = input.value.trim().toLowerCase();
    const matches = [];
    for (const name of this.#spellNames ?? []) {
      if (!q || name.toLowerCase().includes(q)) matches.push(name);
      if (matches.length >= SpellMapConfig.#MAX_SUGGEST) break;
    }
    if (!matches.length) { this.#hideSuggest(); return; }
    ul.replaceChildren(...matches.map(name => {
      const li = document.createElement("li");
      li.textContent = name;
      return li;
    }));
    this.#activeInput = input;
    this.#positionSuggest(input);
    ul.hidden = false;
  }

  /**
   * Anchor the fixed dropdown to an input's on-screen box.
   * @param {HTMLInputElement} input
   */
  #positionSuggest(input) {
    if (!this.#suggestEl) return;
    const r = input.getBoundingClientRect();
    Object.assign(this.#suggestEl.style, {
      left: `${r.left}px`,
      top: `${r.bottom + 2}px`,
      width: `${r.width}px`
    });
  }

  /** Hide the dropdown. */
  #hideSuggest() {
    if (this.#suggestEl) this.#suggestEl.hidden = true;
    this.#activeInput = null;
  }

  /**
   * Caret-button handler: open the dropdown for this combo's input (focusing it),
   * or close it if it's already open for that input.
   * @param {Event} event
   * @param {HTMLElement} target
   */
  static #onToggleSuggest(event, target) {
    const input = target.closest(".cst-map-combo")?.querySelector(".cst-map-to");
    if (!input) return;
    const open = this.#suggestEl && !this.#suggestEl.hidden && this.#activeInput === input;
    if (open) this.#hideSuggest();
    else { this.#showSuggest(input); input.focus(); }
  }

  /**
   * Read every live row from the DOM into a clean, de-duplicated entry array.
   * Rows missing either field are discarded; duplicate `from` keys keep the first.
   * @returns {{from: string, to: string}[]}
   */
  #collectEntries() {
    const out = [];
    const seen = new Set();
    for (const row of this.element.querySelectorAll(".cst-map-row")) {
      const from = row.querySelector(".cst-map-from")?.value?.trim() ?? "";
      const to = row.querySelector(".cst-map-to")?.value?.trim() ?? "";
      if (!from || !to) continue;             // drop incomplete rows
      const key = from.toLowerCase();
      if (seen.has(key)) continue;            // first mapping for a name wins
      seen.add(key);
      out.push({ from, to });
    }
    return out;
  }

  /**
   * Append a blank row by cloning the inert <template> in the rendered form.
   * @param {Event} event
   * @param {HTMLElement} target
   */
  static #onAddEntry(event, target) {
    const tpl = this.element.querySelector("#cst-map-row-template");
    const rows = this.element.querySelector(".cst-map-rows");
    if (tpl && rows) rows.appendChild(tpl.content.firstElementChild.cloneNode(true));
  }

  /**
   * Remove the row containing the clicked trash button.
   * @param {Event} event
   * @param {HTMLElement} target
   */
  static #onRemoveEntry(event, target) {
    target.closest(".cst-map-row")?.remove();
  }

  /**
   * Remove every row.
   * @param {Event} event
   * @param {HTMLElement} target
   */
  static #onClearAll(event, target) {
    this.element.querySelector(".cst-map-rows")?.replaceChildren();
  }

  /**
   * Save handler: persist the collected rows (GM-only write) and notify.
   * @param {Event} event
   * @param {HTMLFormElement} form
   * @param {FormDataExtended} formData
   */
  static async #onSubmit(event, form, formData) {
    await setSpellMap(this.#collectEntries());
    ui.notifications?.info(game.i18n.localize("COMBAT_SPELL_TIMER.Beyond20.SpellMap.Saved"));
  }

  /**
   * Tear down the body-level dropdown and window listeners when the app closes.
   * @param {object} options
   */
  _onClose(options) {
    super._onClose(options);
    document.removeEventListener("pointerdown", this.#onDocPointerDown, true);
    window.removeEventListener("scroll", this.#onWindowChange, true);
    window.removeEventListener("resize", this.#onWindowChange);
    this.#suggestEl?.remove();
    this.#suggestEl = null;
    this.#activeInput = null;
  }
}
