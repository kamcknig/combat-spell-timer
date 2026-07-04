/**
 * Shared "extra superiority die on this Damage roll" label for Battle
 * Master maneuvers declared against a specific weapon attack (Disarming
 * Attack, Distracting Strike). More than one can be armed on the same
 * attack card at once — each contributes its own suffix key/text; the
 * button's label compacts them into one "(A + B)" parenthetical instead of
 * appending a separate one per maneuver.
 */
const BASE_LABEL_MARK = "cstManeuverBaseLabel"; // dataset: the button's original label text, captured once
const SUFFIXES_MARK = "cstManeuverSuffixes";    // dataset: JSON {key: text} of active suffixes

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
