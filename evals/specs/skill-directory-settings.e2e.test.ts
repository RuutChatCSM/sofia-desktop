import { expect } from "vitest";
import { evalIn, waitFor } from "@sofia/behaviors";
import { desktop } from "@sofia/hosts";
import { needs, test } from "@sofia/testkit";

test("skill settings toggle Codex discovery and add or remove custom roots", {timeout:180_000}, async()=>{
 needs({optIn:["SOFIA_EVAL_E2E_TESTS"],placement:"local"});
 await using app=await desktop({name:"skill-directory-settings"});
 await evalIn(app, `(async()=>{
  const {PreferencesView}=await import('/src/react-app/domains/settings/pages/preferences-view.tsx');
  const React=(await import('/node_modules/.vite/deps/react.js')).default;
  const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
  window.__skillSettings={saves:[],toggles:0};
  function Proof(){const [enabled,setEnabled]=React.useState(true);const [dirs,setDirs]=React.useState([]);return React.createElement(PreferencesView,{busy:false,showThinking:false,onToggleShowThinking:()=>{},autoCompactContext:true,autoCompactContextBusy:false,onToggleAutoCompactContext:()=>{},analyticsEnabled:false,onToggleAnalytics:()=>{},desktopNotifications:'off',onDesktopNotificationsChange:()=>{},continuousEngineAvailable:false,continuousEngineEnabled:false,continuousEngineBusy:false,onToggleContinuousEngine:()=>{},memoryEnabled:false,onToggleMemory:()=>{},discoverCodexSkills:enabled,codexSkillsBusy:false,onToggleCodexSkills:()=>{window.__skillSettings.toggles++;setEnabled(value=>!value)},additionalSkillDirectories:dirs,onSaveSkillDirectories:async values=>{window.__skillSettings.saves.push(values);setDirs(values);return true}})}
  const el=document.createElement('div');el.id='skill-settings-proof';document.body.append(el);createRoot(el).render(React.createElement(Proof));
 })()`,{awaitPromise:true});
 await waitFor(app, `!!document.querySelector('#skill-settings-proof [aria-label="Use Codex skills"]')`,{label:"skill controls rendered"});
 expect(await evalIn(app, `document.querySelector('#skill-settings-proof [aria-label="Use Codex skills"]').getAttribute('aria-checked')`)).toBe("true");
 await evalIn(app, `document.querySelector('#skill-settings-proof [aria-label="Use Codex skills"]').click()`);
 await waitFor(app, `document.querySelector('#skill-settings-proof [aria-label="Use Codex skills"]').getAttribute('aria-checked')==='false'`,{label:"Codex skills disabled"});
 await evalIn(app, `(()=>{const input=document.querySelector('#skill-settings-proof input[aria-label="Skill directory"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'~/custom-skills');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 await waitFor(app, `!document.querySelector('#skill-settings-proof button[type="submit"]').disabled`,{label:"directory ready"});
 await evalIn(app, `document.querySelector('#skill-settings-proof button[type="submit"]').click()`);
 await waitFor(app, `!!document.querySelector('#skill-settings-proof [aria-label="Remove ~/custom-skills"]')`,{label:"custom directory added"});
 expect(await evalIn(app, `window.__skillSettings.saves`)).toEqual([["~/custom-skills"]]);
 await evalIn(app, `document.querySelector('#skill-settings-proof [aria-label="Remove ~/custom-skills"]').click()`);
 await waitFor(app, `window.__skillSettings.saves.length===2`,{label:"custom directory removed"});
 expect(await evalIn(app, `window.__skillSettings.saves`)).toEqual([["~/custom-skills"],[]]);
});
