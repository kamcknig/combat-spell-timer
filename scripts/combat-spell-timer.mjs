import { MODULE_ID, log, warn } from "./module.mjs";
import { dbg } from "./utils/debug.mjs";
import { registerInstallTrackerSetting, maybeSendInstallRecord } from "./utils/installTracker.mjs";
import { registerNotificationReceiptsSetting } from "./utils/notification-receipts.mjs";
import { loadAdapter } from "./adapter/index.mjs";
import { registerSocket } from "./core/socket.mjs";
import { onSpellCast, onEarlyRemove } from "./core/timers.mjs";
import { onFeatureStart, onFeatureEarlyEnd, onFeatureTurnEnd, reconcileTurnEndDialogs } from "./core/features.mjs";
import { onRenderTracker } from "./core/tracker.mjs";
import { onRenderActorSheetEffects } from "./core/effect-sheet.mjs";
import { onRenderActorSheetImportButton } from "./core/ddb-sheet-button.mjs";
import { fetchCharacter, parseCharacterId } from "./ddb/client.mjs";
import { onUpdateCombat } from "./core/combat.mjs";
import { onCreateCombatant, onUpdateCombatant, onDeleteCombatant } from "./core/combatant.mjs";
import { registerBeyond20Integration, SETTING as BEYOND20_SETTING, AUTOCAST_SETTING as BEYOND20_AUTOCAST_SETTING } from "./core/beyond20.mjs";
import { SPELL_MAP_SETTING, spellMapField } from "./core/spell-map.mjs";
import { maybeWarnDdbImporterMissing } from "./core/ddb-importer-check.mjs";
import SpellMapConfig from "./apps/spell-map-config.mjs";
import { registerDdbImporterSettings, syncImporterFlag } from "./ddb/settings.mjs";

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "debugLogging", {
    name: "Debug Logging",
    hint: "Write [combat-spell-timer] debug logs to the browser console. Disable for normal play.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false
  });
  game.settings.register(MODULE_ID, BEYOND20_SETTING, {
    // Raw i18n keys: the settings UI localizes name/hint at render time, and
    // translations aren't loaded yet during the init hook.
    name: "COMBAT_SPELL_TIMER.Beyond20.SettingName",
    hint: "COMBAT_SPELL_TIMER.Beyond20.SettingHint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, BEYOND20_AUTOCAST_SETTING, {
    // Raw i18n keys: the settings UI localizes name/hint at render time, and
    // translations aren't loaded yet during the init hook. One switch for both
    // auto-casting spells and auto-applying feature effects (e.g. Rage).
    name: "COMBAT_SPELL_TIMER.Beyond20.AutoCastName",
    hint: "COMBAT_SPELL_TIMER.Beyond20.AutoCastHint",
    scope: "client",
    config: true,
    type: Boolean,
    default: false
  });
  // Hidden world setting: stores the GM-managed Beyond20 spell-name mapping.
  // scope:"world" means every client can read it; only the GM can write.
  game.settings.register(MODULE_ID, SPELL_MAP_SETTING, {
    scope: "world",
    config: false,
    type: spellMapField(),
    default: []
  });
  // GM-only settings-menu button that opens the spell-name mapping editor.
  // restricted:true hides the row from non-GM players.
  game.settings.registerMenu(MODULE_ID, "spellMapMenu", {
    // Raw i18n keys — localized by the settings UI at render time.
    name: "COMBAT_SPELL_TIMER.Beyond20.SpellMap.MenuName",
    label: "COMBAT_SPELL_TIMER.Beyond20.SpellMap.MenuLabel",
    hint: "COMBAT_SPELL_TIMER.Beyond20.SpellMap.MenuHint",
    icon: "fa-solid fa-wand-magic-sparkles",
    type: SpellMapConfig,
    restricted: true
  });
  registerInstallTrackerSetting();
  registerNotificationReceiptsSetting();
  registerDdbImporterSettings();

  // Inject a visual section heading before the first Beyond20 setting so the
  // three related settings are visually grouped in the module settings panel.
  // v13: settings render as <div class="form-group"> with no data-setting-id;
  // the input inside has name="module-id.setting-key".
  Hooks.on("renderSettingsConfig", (_app, html) => {
    const el = html instanceof HTMLElement ? html : html[0];
    if (!el) return;
    const formGroup = el.querySelector(`[name="${MODULE_ID}.${BEYOND20_SETTING}"]`)?.closest(".form-group");
    if (!formGroup || formGroup.previousElementSibling?.classList.contains("cst-settings-heading")) return;
    const heading = document.createElement("h3");
    heading.className = "cst-settings-heading";
    heading.textContent = game.i18n.localize("COMBAT_SPELL_TIMER.Beyond20.SectionHeading");
    formGroup.insertAdjacentElement("beforebegin", heading);
  });

  log("init");
});

Hooks.once("ready", async () => {
  let adapter;
  try {
    adapter = await loadAdapter();
  } catch (err) {
    warn(`no adapter for system "${game.system?.id}" — module inactive`, err);
    return;
  }
  log(`adapter resolved: ${adapter.constructor.SYSTEM_ID}`);
  dbg("ready");
  await maybeSendInstallRecord();
  await maybeWarnDdbImporterMissing();
  adapter.auditEditionMismatches(game.actors.contents)
    .catch((err) => dbg("ready", "edition audit failed", { error: err?.message }));
  adapter.registerEditionMismatchWatch();
  registerSocket();
  adapter.registerCastDetection(onSpellCast);
  adapter.registerEarlyRemoval(onEarlyRemove);
  adapter.registerFeatureDetection((rec) => onFeatureStart(rec, (a, fid, opts) => adapter.applyFeatureEffect(a, fid, opts)));
  adapter.registerFeatureEarlyEnd(onFeatureEarlyEnd);
  adapter.registerFeatureCleanup();
  adapter.registerDuelingSync();
  adapter.registerDefenseSync();
  adapter.registerArcherySync();
  adapter.registerGreatWeaponFightingSync();
  adapter.registerThrownWeaponFightingSync();
  adapter.registerUnarmedFightingSync();
  adapter.registerVisionSync();
  adapter.registerSecondWindSync();
  adapter.registerActionSurgeSync();
  adapter.registerWeaponMasterySync();
  adapter.registerTacticalMindSync();
  adapter.registerIndomitableSync();
  adapter.registerManeuverDamageDiceSync();
  adapter.registerCommandersStrikeSync();
  adapter.registerDisarmingAttackSync();
  adapter.registerDistractingStrikeSync();
  adapter.registerEvasiveFootworkSync();
  adapter.registerFeintingAttackSync();
  adapter.registerGoadingAttackSync();
  adapter.registerLungingAttackSync();
  adapter.registerManeuveringAttackSync();
  adapter.registerMenacingAttackSync();
  adapter.registerPrecisionAttackSync();
  adapter.registerPushingAttackSync();
  adapter.registerRallySync();
  adapter.registerRiposteSync();
  adapter.registerSweepingAttackSync();
  Hooks.on("combatTurnChange", (combat, previous, _current) => onFeatureTurnEnd(combat, previous));
  Hooks.on("renderCombatTracker", onRenderTracker);
  Hooks.on("renderActorSheetV2", onRenderActorSheetEffects);
  Hooks.on("renderActorSheetV2", onRenderActorSheetImportButton);
  game.modules.get(MODULE_ID).ddb = { fetchCharacter, parseCharacterId };
  // Advertise (or clear) this GM's cobalt presence so imports route to a cobalt-holding GM.
  await syncImporterFlag();
  // Cached raw .data lives on the actor: actor.getFlag("combat-spell-timer", "ddbSource")
  Hooks.on("updateCombat", onUpdateCombat);
  // Close a feature's turn-end dialog when its timer is removed by any path.
  Hooks.on("updateCombat", reconcileTurnEndDialogs);
  Hooks.on("createCombatant", onCreateCombatant);
  Hooks.on("updateCombatant", onUpdateCombatant);
  Hooks.on("deleteCombatant", onDeleteCombatant);
  registerBeyond20Integration();
  // Re-render the tracker so any timers already in flags appear immediately.
  ui.combat?.render();
});
