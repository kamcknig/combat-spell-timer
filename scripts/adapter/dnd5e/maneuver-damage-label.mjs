/**
 * Shared "extra superiority die on this Damage roll" label for Battle
 * Master maneuvers declared against a specific weapon attack (Disarming
 * Attack, Distracting Strike). More than one can be armed on the same
 * attack card at once — each contributes its own suffix key/text; the
 * button's label compacts them into one "(A + B)" parenthetical instead of
 * appending a separate one per maneuver.
 *
 * This module also covers each maneuver's own REFUND RESOURCE button: when
 * only one such maneuver is armed on a card, its refund button stays plain
 * ("REFUND RESOURCE"); once a second one is armed alongside it, both need to
 * say which resource they refund ("REFUND RESOURCE (Disarming)" / "REFUND
 * RESOURCE (Distracting)") since there's more than one to pick between.
 */
const BASE_LABEL_MARK = "cstManeuverBaseLabel"; // dataset: the button's original label text, captured once
const SUFFIXES_MARK = "cstManeuverSuffixes";    // dataset: JSON {key: text} of active suffixes
const REFUND_CLASS = "cst-maneuver-refund";     // shared class across every maneuver's own refund button, for counting
const REFUND_TEXT_MARK = "cstManeuverRefundText"; // dataset: this refund button's own resource-specific suffix text

function damageButtonAndLabel(container) {
  const btn = container.querySelector('button[data-action="rollDamage"]');
  const label = btn?.querySelector("span");
  return label ? { btn, label } : {};
}

function render(btn, label) {
  const base = btn.dataset[BASE_LABEL_MARK];
  const active = JSON.parse(btn.dataset[SUFFIXES_MARK] ?? "{}");
  const texts = Object.values(active);
  label.textContent = texts.length ? `${base} (${texts.join(" + ")})` : base;
}

/** Add `key`'s suffix (idempotent) and re-render the compacted label. */
export function addDamageButtonSuffix(container, key, text) {
  const { btn, label } = damageButtonAndLabel(container);
  if (!btn) return;
  if (btn.dataset[BASE_LABEL_MARK] === undefined) btn.dataset[BASE_LABEL_MARK] = label.textContent.trim();
  const active = JSON.parse(btn.dataset[SUFFIXES_MARK] ?? "{}");
  if (active[key] === text) return;
  active[key] = text;
  btn.dataset[SUFFIXES_MARK] = JSON.stringify(active);
  render(btn, label);
}

/** Remove `key`'s suffix (e.g. on refund) and re-render the compacted remainder. */
export function removeDamageButtonSuffix(container, key) {
  const { btn, label } = damageButtonAndLabel(container);
  if (!btn || !btn.dataset[SUFFIXES_MARK]) return;
  const active = JSON.parse(btn.dataset[SUFFIXES_MARK]);
  if (!(key in active)) return;
  delete active[key];
  btn.dataset[SUFFIXES_MARK] = JSON.stringify(active);
  render(btn, label);
}

/** Mark `btn` as a maneuver refund button carrying `text` as its resource-specific suffix, then re-render every refund button's label in `container`. Call once, right after `btn` is inserted into `container`. */
export function markRefundButton(container, btn, text) {
  btn.classList.add(REFUND_CLASS);
  btn.dataset[REFUND_TEXT_MARK] = text;
  renderRefundButtonLabels(container);
}

/**
 * Recompute every maneuver refund button's label in `container`: plain
 * "REFUND RESOURCE" when only one is present, "REFUND RESOURCE (<text>)" for
 * each once more than one are armed together. Call after adding a refund
 * button (via markRefundButton) AND after removing one (on refund, so any
 * sibling that stays armed reverts to the plain label).
 */
export function renderRefundButtonLabels(container) {
  const buttons = container.querySelectorAll(`.${REFUND_CLASS}`);
  const generic = game.i18n.localize("COMBAT_SPELL_TIMER.RefundResourceButton");
  for (const btn of buttons) {
    const span = btn.querySelector("span");
    if (!span) continue;
    const text = btn.dataset[REFUND_TEXT_MARK];
    span.textContent = buttons.length > 1 && text ? `${generic} (${text})` : generic;
  }
}
