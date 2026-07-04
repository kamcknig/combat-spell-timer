# Features

Brief inventory of what this module does — one line per feature, grouped by area.

## Core Timer Engine

- **Combat tracker timers** — per-combatant row showing rounds/turns remaining for an active spell or feature; counts down automatically and clears on expiry.
- **Effects panel** — expandable list of an actor's active effects under their tracker row, each showing source and rounds remaining.
- **Concentration prompt on join** — when a combatant already concentrating on a trackable spell joins combat, the GM is prompted to add a timer or drop concentration.
- **Effect-sheet duration override** — actor sheet effect rows show live remaining rounds instead of the internal sentinel duration.
- **Single-writer election** — only the active GM's client performs timer/effect writes, avoiding duplicate/conflicting updates.

## D&D Beyond Import

- **Character import** — pulls a character from D&D Beyond via a cobalt session cookie and import proxy.
- **Cobalt cookie config** — GM dialog to paste, save, clear, and validate the cobalt session cookie.
- **Actor sheet import button** — one-click import trigger injected into the actor sheet header (edit mode).
- **Class/subclass/feature creation** — builds dnd5e class, subclass, and feat items from imported data, gated by character level.
- **Edition-mismatch audit** — detects when imported content's edition (2014/2024) disagrees with the world's dnd5e Rules Version setting; warns the GM via an acknowledgeable dialog + console log, re-checked on import, on settings change, and on world start.
- **ddb-importer recommendation** — warns the GM once if the companion `ddb-importer` module isn't installed/active.

## Beyond20 Integration

- **Auto-cast from Beyond20** — spells cast via the Beyond20 browser extension automatically start a tracker timer.
- **Auto-apply feature effects** — Beyond20-triggered feature activations automatically apply their effect.
- **Spell-name mapping editor** — GM tool to map Beyond20's spell names to this world's spell names when they don't match.

## Class Features

- **Rage (Barbarian)** — damage bonus, resistances, advantage on STR checks/saves; edition-aware duration and early-end rules.
- **Wild Surge (Barbarian, Wild Magic)** — auto-rolls the Wild Magic table on every rage start.
- **Totem Spirit / Totemic Attunement (Barbarian, Totem Warrior)** — animal-boon effect while raging.
- **Form of the Beast (Barbarian, Path of the Beast, 2014)** — grants a natural weapon item while raging.
- **Zealous Presence (Barbarian, Zealot)** — grants a buff to up to ten allies until the caster's next turn.
- **Path to the Grave (Cleric)** — marks a target vulnerable to the next attack.
- **Symbiotic Entity (Druid, Circle of Spores)** — temporary self buff adding necrotic damage.
- **Wrath of the Sea (Druid, Circle of the Sea)** — tracked aura activation.
- **Moonlight Step (Druid, Circle of the Moon, 2024)** — advantage marker on the caster's next attack this turn.
- **Action Surge (Fighter)** — grants an extra action on your turn (not the Magic action); tracked uses (1, or 2 at level 17+) recovered on a short or long rest, imported with the actual resolved count from D&D Beyond.
- **Indomitable (Fighter, 2014)** — reroll a failed saving throw via an INDOMITABLE chat-card button and a USE/CHAT announcement; tracked uses (1/2/3 at level 9/13/17) recovered on a long rest, imported with the actual resolved count from D&D Beyond.
- **Extra Attack (Fighter, 2014)** — cosmetic descriptive item only; collapsed to the single tier (twice/three times/four times) applicable at the character's current level.
- **Tactical Mind (Fighter, 2024)** — expend a Second Wind use for a 1d10 bonus to a failed ability check, via a USE/CHAT announcement and a chat-card BONUS-roll button.
- **Giant's Might (Fighter, Rune Knight)** — size increase + advantage on STR saves for 1 minute.
- **Weapon Mastery (Fighter, 2024)** — one "Weapon Mastery: &lt;weapon&gt; &lt;property&gt;" feat item per weapon+property chosen at import (imported from D&D Beyond), covering all 8 properties. Mechanical: **Cleave** (extra no-mod attack via a chat-card button), **Graze** (flat ability-mod damage via a chat-card button), **Sap** (target disadvantage on their next attack, applied via the damage card's Effects tray), **Slow** (target speed -10 ft, non-stacking, applied via the damage card's Effects tray), **Topple** (Con save-or-prone via a chat-card button). Cosmetic only (property text visible on the weapon's own sheet, no module mechanics): **Nick**, **Push**, **Vex**.
- **Battle Master (Fighter, 2014)** — imports the Battle Master subclass with a **Combat Superiority** feature carrying the superiority-dice pool (count + die size resolved from D&D Beyond, short-rest recovery) and each chosen maneuver as a cosmetic "Maneuver: <name>" item. **Commander's Strike** is wired: activate it from the item or from a **COMMANDER'S STRIKE** button injected into the attack-roll dialog (shown only when a die is available) → USE/CHAT dialog → USE spends one superiority die → chat card with a superiority-die roll button any player can press; once rolled, that button becomes a **REFUND RESOURCE** button (returns the die to the pool and swaps back to the roll button). **Disarming Attack** is wired: a **DISARMING ATTACK** button on a weapon's attack card → USE/CHAT dialog → USE spends one superiority die and relabels the card's Damage button to "Damage (Disarming)" (CHAT just posts the announcement) → the next damage roll from that card automatically includes the superiority die → the resulting damage message gets a **Strength Save** button that rolls the maneuver's save for all targeted (or, if none, all controlled) tokens; the DISARMING ATTACK button becomes a **REFUND RESOURCE** button once armed, returning the die and (if damage hasn't been rolled yet) undoing the pending die/label and swapping back to a fresh DISARMING ATTACK button.
- **Misc effect corrections** — fixes for a few ddb-imported effects whose automation is incomplete (e.g. Cloak of Shadows ending on attack/cast, duration corrections, status-triggered effect removal).

## Fighting Styles

- **Archery** — +2 to ranged attack rolls.
- **Defense** — +1 AC while wearing armor (2024: restricted to Light/Medium/Heavy).
- **Dueling** — +2 damage with a one-handed melee weapon and no other weapon.
- **Great Weapon Fighting** — reroll (2014) or treat-as-3 (2024) low damage dice on two-handed melee weapons.
- **Thrown Weapon Fighting** — +2 damage on thrown-weapon attacks.
- **Unarmed Fighting** — improved unarmed strike damage + grapple damage-over-time option.
- **Blind Fighting** — grants blindsight, synced to actual token vision.
- **Protection / Interception** — icon/marker only; no mechanical effect implemented yet.

## Vision & Senses

- **Senses-to-vision sync** — keeps token detection modes (e.g. blindsight) in sync with an actor's derived senses whenever they change.

## Settings

- Debug logging toggle.
- Beyond20 integration toggle + auto-cast/auto-apply toggle.
- Beyond20 spell-name mapping (hidden, edited via its own dialog).
- D&D Beyond cobalt session cookie (client-scoped).
