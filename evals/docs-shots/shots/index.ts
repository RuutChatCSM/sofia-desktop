import type { Shot } from "./shot.ts";
import { denSofiaWeb, denPluginDetail, denSkillEditor } from "./den-web.ts";
import {
  desktopTeamPromptCards,
  libraryAddMcpModal,
  libraryAddMcpSlack,
  libraryAdvancedSettings,
  libraryCreateSkillModal,
  librarySkills,
  librarySlackConnection,
  skillCreatedCard,
} from "./desktop.ts";
import { sofiaWebTab } from "./web-tab.ts";

export const shots: Shot[] = [
  desktopTeamPromptCards,
  librarySkills,
  libraryCreateSkillModal,
  libraryAdvancedSettings,
  libraryAddMcpModal,
  libraryAddMcpSlack,
  librarySlackConnection,
  skillCreatedCard,
  denPluginDetail,
  denSkillEditor,
  denSofiaWeb,
  sofiaWebTab,
];
