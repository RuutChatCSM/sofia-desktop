import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { discoveredSkillInventory } from "../../apps/server/src/codex-skill-inventory";

test("Library uses effective engine paths and excludes disabled or removed roots",async()=>{
 const local={name:"shared",path:"/sofia/skills/shared/SKILL.md",description:"Old",scope:"global" as const};
 const raw={data:[{skills:[{name:"shared",path:"/codex/skills/shared/SKILL.md",description:"Effective",scope:"user",enabled:true},{name:"custom",path:"/custom/test/SKILL.md",description:"Custom",scope:"user",enabled:true},{name:"disabled",path:"/custom/off/SKILL.md",enabled:false}]}]};
 const items=discoveredSkillInventory(raw,[local]);
 expect(items).toEqual([{name:"shared",path:"/codex/skills/shared/SKILL.md",description:"Effective",scope:"global",sourceDirectory:"/codex/skills/shared",readOnly:true},{name:"custom",path:"/custom/test/SKILL.md",description:"Custom",scope:"global",sourceDirectory:"/custom/test",readOnly:true}]);
 expect(discoveredSkillInventory({data:[{skills:[]}]},[local])).toEqual([]);
 const {buildExtensionItems}=await import("../../apps/app/src/react-app/domains/settings/extension-items");
 const built=buildExtensionItems({quickConnect:[],mcpServers:[],installedSkills:items,importedCloudPlugins:[],pendingCloudPluginChanges:[],cloudMarketplaces:[],orgMcpConnections:[],isBuiltInConnected:()=>false});
 expect(built.installedSkills).toEqual(items);
});
