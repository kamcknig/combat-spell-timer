# TODO — Class features with durations (candidates for implementation)

Extracted from ddb-importer's bundled enrichers (`$FVTT_V14_DATA_PATH/Data/modules/ddb-importer/dist/main.mjs`).

**Criteria:** the feature's enricher defines a temporary ActiveEffect with an explicit
`durationSeconds` / `durationRounds` / `durationTurns`, or an activity duration in
rounds/minutes/hours. Spells (already tracked by the spell map), magic items, and monster
features are excluded.

**Notes**
- *AE changes* = ddb-importer defines `changes` to copy into our own effect (per CLAUDE.md
  workflow). "marker" = ddb creates only a marker/status effect with no stat changes — we'd
  just track the timer.
- Conversion: 1 round = 6 s · 1 min = 10 rounds · 10 min = 100 rounds.
- The bracketed name is the enricher class to grep for in `main.mjs`
  (e.g. `grep -o 'class GiantsMight extends.\{0,800\}' main.mjs`).
- Caveat: features whose duration ddb parses from description text at import time
  (`DDBDescriptions.getDuration`) are not in this list — only explicit durations.

## Barbarian

- [x] Rage — 1 min (2014) / 10 min (2024) — AE changes — `Rage` *(implemented)*
- [x] Form of the Beast (Path of the Beast) — lasts until the rage ends — manifests a Bite/Claws/Tail natural weapon — `FormOfTheBeast`, weapon variants in `FormOfTheBeastWeapons` *(implemented)*
- [x] Bolstering Magic (Wild Magic) — 10 min (100 rounds) — handled in Foundry by dnd5e; Beyond20 activation button added — `BolsteringMagic` *(implemented)*
- [x] Wild Surge (Wild Magic) — auto-triggers on rage start; rage-bound results (markers, Multicolored Light, weapon enchantment) end with the rage — `WildSurge` *(implemented)*
- [x] Zealous Presence (Zealot) — until the start of the caster's next turn — caster-anchored timer, target-side cleanup, Beyond20 button — `ZealousPresence` *(implemented)*
- [x] Totem Spirit: Bear / Eagle / Elk / Tiger / Wolf (Totem Warrior) — rage-bound effects: Bear resistances, Elk +15 ft speed, Eagle/Tiger/Wolf markers — `TotemSpiritBear` etc. *(implemented)*
- [ ] Totemic Attunement: Bear / Eagle / Elk / Tiger / Wolf (Totem Warrior) — lasts while raging — Eagle has AE changes, rest marker — `TotemicAttunementBear` etc.

## Bard

- [ ] Bardic Inspiration — 10 min (100 rounds) — marker — `BardicInspiration`
- [ ] Unbreakable Majesty (Glamour) — 1 min (10 rounds) — marker — `UnbreakableMajesty`
- [ ] Spirits From Beyond (Spirits) — 1 round — AE changes — `SpiritsFromBeyond`
- [ ] Inspired Eclipse — 1 round — marker — `InspiredEclipse`

## Cleric

- [ ] Channel Divinity: Twilight Sanctuary (Twilight) — 1 min (10 rounds) — AE changes — `ChannelDivinityTwilightSanctuary`
- [ ] Channel Divinity: Cloak of Shadows (Trickery) — 1 min (10 rounds) — marker — `ChannelDivinityCloakOfShadows`
- [ ] Channel Divinity: Path to the Grave (Grave) — 1 round — AE changes — `ChannelDivinityPathToTheGrave` (2024 variant: `PathToTheGrave`)
- [ ] Steps of Night (Twilight) — 1 min (10 rounds) — AE changes — `StepsOfNight`
- [ ] Eyes of Night (Twilight) — 1 hour — AE changes — `EyesOfNight`
- [ ] Divine Foreknowledge — 1 hour — AE changes — `DivineForeknowledge`
- [ ] Blessing of the Forge (Forge) — 24 hours (low combat value) — AE changes — `BlessingOfTheForge`

## Druid

- [ ] Symbiotic Entity (Spores) — 10 min (100 rounds) — AE changes — `SymbioticEntity`
- [ ] Wrath of the Sea (Sea) — 10 min (100 rounds) — marker — `WrathOfTheSea`
- [ ] Moonlight Step — 1 turn — AE changes — `MoonlightStep`
- [ ] Circle Forms / Wild Shape (Moon) — `floor(druid level / 2)` hours — AE changes — `CircleForms`

## Fighter

- [ ] Giant's Might (Rune Knight) — 1 min (10 rounds) — AE changes — `GiantsMight`
- [ ] Fire Rune (Rune Knight) — 1 min (10 rounds) — AE changes — `FireRune`
- [ ] Frost Rune (Rune Knight) — 10 min (100 rounds) — AE changes — `FrostRune`
- [ ] Hill Rune (Rune Knight) — 1 min (10 rounds) — AE changes — `HillRune`
- [ ] Stone Rune (Rune Knight) — 1 min (10 rounds) — AE changes — `StoneRune`
- [ ] Storm Rune (Rune Knight) — 1 min (10 rounds) — marker — `StormRune`
- [ ] Banishing Arrow (Arcane Archer) — 2 rounds — marker — `BanishingArrow`
- [ ] Beguiling Arrow (Arcane Archer) — 2 rounds — marker — `BeguilingArrow`
- [ ] Shadow Arrow (Arcane Archer) — 2 rounds — marker — `ShadowArrow`
- [ ] Bulwark of Force (Psi Warrior) — 1 min (10 rounds) — marker — `BulwarkOfForce`
- [ ] Unwavering Mark (Cavalier) — 1 round — AE changes — `UnwaveringMark`
- [ ] Hold the Line (Cavalier) — until end of turn (3 s) — AE changes — `HoldTheLine`

## Monk

- [ ] Patient Defense — 1 round — marker — `PatientDefense`
- [ ] Step of the Wind — 1 round — marker — `StepOfTheWind`
- [ ] Empty Body — 1 min (10 rounds) — AE changes — `EmptyBody`
- [ ] Flurry of Blows: Addle / Push / Topple (Open Hand 2024) — 1 turn — marker — `FlurryOfBlowsAdditional`
- [ ] Superior Defense (Open Hand) — 1 min (10 rounds) — AE changes — `SuperiorDefense`
- [ ] Agile Parry (Kensei) — 1 round — AE changes — `AgileParry`
- [ ] Sharpen the Blade (Kensei) — 1 min (10 rounds) — marker — `SharpenTheBlade`
- [ ] Arms of the Astral Self (Astral Self) — 10 min (100 rounds) — AE changes — `ArmsOfTheAstralSelf`
- [ ] Visage of the Astral Self (Astral Self) — 10 min — AE changes — `VisageOfTheAstralSelf` (effect says 360 s, activity 10 min — ddb inconsistency)
- [ ] Awakened Astral Self (Astral Self) — 10 min (100 rounds) — AE changes — `AwakenedAstralSelf`
- [ ] Aspect of the Wyrm (Ascendant Dragon) — 10 min (100 rounds) — AE changes — `AspectOfTheWyrm`
- [ ] Fangs of the Fire Snake (Four Elements) — 1 turn — AE changes — `FangsOfTheFireSnake`
- [ ] Drunken Technique (Drunken Master) — until end of turn (4 s) — AE changes — `DrunkenTechnique`

## Paladin

- [ ] Sacred Weapon (Devotion) — 10 min (100 rounds) — AE changes — `SacredWeapon_SacredWeapon`
- [ ] Vow of Enmity (Vengeance) — 1 min (10 rounds) — marker — `VowOfEnmity`
- [ ] Relentless Avenger (Vengeance) — 1 round — AE changes — `RelentlessAvenger`
- [ ] Avenging Angel (Vengeance) — 10 min (100 rounds) — AE changes — `AvengingAngel`
- [ ] Invincible Conqueror (Conquest) — 1 min (10 rounds) — AE changes — `InvincibleConqueror`
- [ ] Emissary of Peace (Redemption) — 10 min (100 rounds) — AE changes — `EmissaryOfPeace`
- [ ] Channel Divinity: Watcher's Will (Watchers) — 1 min (10 rounds) — AE changes — `ChannelDivinityWatchersWill`
- [ ] Channel Divinity: Abjure the Extraplanar (Watchers) — 1 min (10 rounds) — marker — `ChannelDivinityAbjureTheExtraplanar`
- [ ] Channel Divinity: Peerless Athlete (Glory) — 10 min / 1 hour — AE changes — `ChannelDivinityPeerlessAthlete` (2024 variant: `PeerlessAthlete`)
- [ ] Elemental Strike — 2 rounds — AE changes — `ElementalSmite`
- [ ] Smite of Protection — 1 round — marker — `SmiteOfProtection`
- [ ] Noble Scion — 10 min (100 rounds) — AE changes — `NobleScion`

## Ranger

- [ ] Dread Ambusher (Gloom Stalker) — 1 round — AE changes — `DreadAmbusher`
- [ ] Nature's Veil — 2 rounds — marker — `NaturesVeil`
- [ ] Planar Warrior (Horizon Walker) — 1 turn — marker — `PlanarWarrior`
- [ ] Beguiling Twist (Fey Wanderer) — 1 min (10 rounds) — marker — `BeguilingTwist`
- [ ] Dreadful Strike: Mass Fear (Fey Wanderer) — 1 round — marker — `DreadfulStrikeMassFear`
- [ ] Superior Hunter's Defense (Hunter) — 1 round — AE changes — `SuperiorHuntersDefense`
- [ ] Writhing Tide (Swarmkeeper) — 1 min (10 rounds) — AE changes — `WrithingTide`
- [ ] Take Ghastly Form (Hollow Warden) — 1 min (10 rounds) — AE changes — `TakeGhastlyForm`
- [ ] Wrath of the Wild (Hollow Warden) — 1 min (10 rounds) — AE changes — `WrathOfTheWild`
- [ ] Frozen Haunt (Winter Walker) — 10 min (100 rounds) — AE changes — `FrozenHaunt`
- [ ] Sealed Fate — 1 min (10 rounds) — marker — `SealedFate`
- [ ] Omen of Doom — 1 hour — marker — `OmenOfDoom`

## Rogue

- [ ] Steady Aim — until end of turn — AE changes — `SteadyAim`
- [ ] Cunning Strike (2024) — 1 min (10 rounds) — marker — `CunningStrike`
- [ ] Devious Strikes (2024) — 1 min (10 rounds) — marker — `DeviousStrikes`
- [ ] Panache (Swashbuckler) — 1 min (10 rounds) — AE changes — `Panache`
- [ ] Insightful Fighting (Inquisitive) — 1 min (10 rounds) — marker — `InsightfulFighting`
- [ ] Ghost Walk (Phantom) — 10 min (100 rounds) — AE changes — `GhostWalk`

## Sorcerer

- [ ] Dragon Wings (Draconic) — 10 min (100 rounds) — AE changes — `DragonWings`
- [ ] Lunar Phenomenon (Lunar) — 1 round — AE changes — `LunarPhenomenon`
- [ ] Revelation in Flesh (Aberrant Mind) — 10 min (100 rounds) — AE changes — `RevelationInFlesh`
- [ ] Telepathic Speech (Aberrant Mind) — sorcerer-level minutes — marker — `TelepathicSpeech`
- [ ] Trance of Order (Clockwork) — 1 min (10 rounds) — marker — `TranceOfOrder`

## Warlock

- [ ] Form of Dread (Undead) — 1 min (10 rounds) — AE changes — `FormOfDread`
- [ ] Form of the Beast (warlock patron, newer content) — 10 min (100 rounds) — AE changes — `FormOfTheBeast_FormOfTheBeast`
- [ ] Steps of the Fey (Archfey) — 1 round — AE changes — `StepsOfTheFey`
- [ ] Hurl Through Hell (Fiend) — 2 rounds — marker — `HurlThroughHell`
- [ ] Searing Vengeance (Celestial) — 1 round — marker — `SearingVengeance`
- [ ] Spirit Projection (Undead) — 1 hour — AE changes — `SpiritProjectionProjectSpirit`

## Wizard

- [ ] Bladesong (Bladesinging) — 1 min (10 rounds) — AE changes — `Bladesong`
- [ ] Song of Victory (Bladesinging) — 1 min (10 rounds) — AE changes — `SongOfVictory`
- [ ] Arcane Deflection (War Magic) — 1 round — AE changes — `ArcaneDeflection`
- [ ] Momentary Stasis (Graviturgy) — 1 round — AE changes — `MomentaryStasis`

## Artificer

- [ ] Macabre Modifications — 1 round — AE changes — `MacabreModifications`

---

## Appendix A — Feats with durations (optional)

- [ ] Defensive Duelist — 1 round / until next turn — AE changes — `DefensiveDuelist`
- [ ] Slasher — 1 round — AE changes — `Slasher`
- [ ] Standard Bearer — 1 min (10 rounds) — AE changes — `StandardBearer`
- [ ] Strike of the Giants — 1 round — AE changes — `StrikeOfTheGiants`
- [ ] Flustering Strike — 1 round — AE changes — `FlusteringStrike`
- [ ] Boon of the Night Spirit — 1 round — AE changes — `BoonOfTheNightSpirit`
- [ ] Poisoner — 1 hour (poison application; low combat value) — marker — `Poisoner`

## Appendix B — Species traits with durations (optional)

- [ ] Celestial Revelation (Aasimar) — 1 min (10 rounds) — AE changes — `CelestialRevelation` (+ `…HeavenlyWings` / `…InnerRadiance` / `…RadiantSoul` variants)
- [ ] Radiant Soul (Aasimar legacy) — 1 min (10 rounds) — AE changes — `RadiantSoul_RadiantSoul`
- [ ] Draconic Flight (Dragonborn 2024) — 10 min (100 rounds) — AE changes — `DraconicFlight`
- [ ] Large Form (Goliath 2024) — 10 min (100 rounds) — AE changes — `LargeForm`
- [ ] Stonecunning (Dwarf 2024) — 10 min (100 rounds) — AE changes — `Stonecunning`
- [ ] Fey Step (Eladrin) — 1 min (10 rounds) — marker — `FeyStep`
- [ ] Blessing of the Raven Queen (Shadar-kai) — 1 round — AE changes — `BlessingOfTheRavenQueen`
- [ ] Shifting (Shifter) — 1 min (10 rounds) — AE changes — `Shifting`
