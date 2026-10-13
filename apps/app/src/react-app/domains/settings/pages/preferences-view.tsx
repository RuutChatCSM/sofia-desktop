/** @jsxImportSource react */
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

import { t } from "@/i18n";
import {
  DESKTOP_NOTIFICATION_PREFERENCE_VALUES,
  isDesktopNotificationPreference,
  type DesktopNotificationPreference,
} from "@/react-app/kernel/desktop-notification-preferences";
import {
  LayoutSection,
  LayoutSectionDescription,
  LayoutSectionHeader,
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
  LayoutSectionTitle,
  LayoutStack,
} from "../settings-layout";
import { DesktopIntegrationSection } from "../desktop-integration-section";

export type PreferencesViewProps = {
  busy: boolean;
  showThinking: boolean;
  onToggleShowThinking: () => void;
  autoCompactContext: boolean;
  autoCompactContextBusy: boolean;
  onToggleAutoCompactContext: () => void;
  discoverCodexSkills: boolean;
  codexSkillsBusy: boolean;
  onToggleCodexSkills: () => void;
  additionalSkillDirectories: string[];
  onSaveSkillDirectories: (directories: string[]) => Promise<boolean>;
  analyticsEnabled: boolean;
  onToggleAnalytics: () => void;
  desktopNotifications: DesktopNotificationPreference;
  onDesktopNotificationsChange: (value: DesktopNotificationPreference) => void;
  continuousEngineAvailable: boolean;
  continuousEngineEnabled: boolean;
  continuousEngineBusy: boolean;
  onToggleContinuousEngine: () => void;
  memoryEnabled: boolean;
  onToggleMemory: () => void;
};

function desktopNotificationPreferenceLabel(value: DesktopNotificationPreference) {
  switch (value) {
    case "important":
      return t("settings.desktop_notifications.important");
    case "all":
      return t("settings.desktop_notifications.all");
    case "off":
      return t("settings.desktop_notifications.off");
  }
}

export function PreferencesView(props: PreferencesViewProps) {
  const [skillDirectory, setSkillDirectory] = useState("");
  const [skillDirectoryError, setSkillDirectoryError] = useState<string | null>(null);
  const desktopNotificationItems = DESKTOP_NOTIFICATION_PREFERENCE_VALUES.map((value) => ({
    value,
    label: desktopNotificationPreferenceLabel(value),
  }));

  return (
    <LayoutStack>
      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>{t("settings.model_title")}</LayoutSectionTitle>
          <LayoutSectionDescription>{t("settings.model_section_desc")}</LayoutSectionDescription>
        </LayoutSectionHeader>

        {/* Show reasoning */}
        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>{t("settings.show_model_reasoning")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>{t("settings.show_model_reasoning_desc")}</LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <Switch
                aria-label={t("settings.show_model_reasoning")}
                checked={props.showThinking}
                disabled={props.busy}
                onCheckedChange={props.onToggleShowThinking}
              />
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>

        {/* Auto context compaction */}
        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>{t("settings.auto_compact")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>{t("settings.auto_compact_desc")}</LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <Switch
                aria-label={t("settings.auto_compact")}
                checked={props.autoCompactContext}
                disabled={props.busy || props.autoCompactContextBusy}
                onCheckedChange={props.onToggleAutoCompactContext}
              />
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>

      </LayoutSection>

      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>{t("settings.desktop_notifications.title")}</LayoutSectionTitle>
          <LayoutSectionDescription>{t("settings.desktop_notifications.section_desc")}</LayoutSectionDescription>
        </LayoutSectionHeader>

        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>{t("settings.desktop_notifications.mode")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>{t("settings.desktop_notifications.mode_desc")}</LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <div className="w-44 max-w-full">
                <Select
                  value={props.desktopNotifications}
                  items={desktopNotificationItems}
                  onValueChange={(value) => {
                    if (isDesktopNotificationPreference(value)) {
                      props.onDesktopNotificationsChange(value);
                    }
                  }}
                  disabled={props.busy}
                >
                  <SelectTrigger className="w-full" aria-label={t("settings.desktop_notifications.mode")}>
                    <SelectValue placeholder={t("settings.desktop_notifications.off")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {DESKTOP_NOTIFICATION_PREFERENCE_VALUES.map((value) => (
                        <SelectItem key={value} value={value}>
                          {desktopNotificationPreferenceLabel(value)}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>
      </LayoutSection>

      <DesktopIntegrationSection />
      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>Skills</LayoutSectionTitle>
          <LayoutSectionDescription>Choose which local skills Sofia can discover in this workspace.</LayoutSectionDescription>
        </LayoutSectionHeader>
        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>Use Codex skills</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>Include skills from your home folder’s .codex/skills directory. Files stay in their original location. Changes apply to subsequent turns.</LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <Switch aria-label="Use Codex skills" checked={props.discoverCodexSkills} disabled={props.busy || props.codexSkillsBusy} onCheckedChange={props.onToggleCodexSkills} />
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>
        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>Additional skill directories</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>Enter a directory containing skills with SKILL.md files. Use an absolute path or ~/ for your home folder.</LayoutSectionItemDescription>
          </LayoutSectionItemHeader>
          <div className="mt-3 space-y-2">
            {props.additionalSkillDirectories.map(directory => <div key={directory} className="flex items-center gap-2"><span className="min-w-0 flex-1 break-all text-sm">{directory}</span><Button variant="ghost" size="sm" disabled={props.busy || props.codexSkillsBusy} aria-label={`Remove ${directory}`} onClick={() => void props.onSaveSkillDirectories(props.additionalSkillDirectories.filter(path => path !== directory))}>Remove</Button></div>)}
            <form className="flex gap-2" onSubmit={event => {
              event.preventDefault();
              const path = skillDirectory.trim();
              if (!path || !/^(?:\/|~\/|[A-Za-z]:[\\/])/.test(path)) { setSkillDirectoryError("Enter an absolute directory path or a path starting with ~/."); return; }
              setSkillDirectoryError(null);
              void props.onSaveSkillDirectories([...new Set([...props.additionalSkillDirectories, path])]).then(saved => { if (saved) setSkillDirectory(""); });
            }}>
              <Input aria-label="Skill directory" placeholder="~/my-skills" value={skillDirectory} disabled={props.busy || props.codexSkillsBusy} onChange={event => setSkillDirectory(event.target.value)} />
              <Button type="submit" disabled={props.busy || props.codexSkillsBusy || !skillDirectory.trim()}>Add</Button>
            </form>
            {skillDirectoryError && <p role="alert" className="text-sm text-destructive">{skillDirectoryError}</p>}
          </div>
        </LayoutSectionItem>
      </LayoutSection>

      {props.continuousEngineAvailable ? (
        <LayoutSection>
          <LayoutSectionHeader>
            <LayoutSectionTitle>{t("settings.engine_rollover_title")}</LayoutSectionTitle>
            <LayoutSectionDescription>{t("settings.engine_rollover_section_desc")}</LayoutSectionDescription>
          </LayoutSectionHeader>

          <LayoutSectionItem>
            <LayoutSectionItemHeader>
              <LayoutSectionItemTitle>{t("settings.engine_rollover_toggle")}</LayoutSectionItemTitle>
              <LayoutSectionItemDescription>{t("settings.engine_rollover_toggle_desc")}</LayoutSectionItemDescription>
              <LayoutSectionItemHeaderActions>
                <Switch
                  aria-label={t("settings.engine_rollover_toggle")}
                  checked={props.continuousEngineEnabled}
                  disabled={props.busy || props.continuousEngineBusy}
                  onCheckedChange={props.onToggleContinuousEngine}
                />
              </LayoutSectionItemHeaderActions>
            </LayoutSectionItemHeader>
          </LayoutSectionItem>
        </LayoutSection>
      ) : null}

      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>{t("settings.privacy_title")}</LayoutSectionTitle>
          <LayoutSectionDescription>{t("settings.privacy_section_desc")}</LayoutSectionDescription>
        </LayoutSectionHeader>

        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>{t("settings.analytics_toggle")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>{t("settings.analytics_toggle_desc")}</LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <Switch
                aria-label={t("settings.analytics_toggle")}
                checked={props.analyticsEnabled}
                disabled={props.busy}
                onCheckedChange={props.onToggleAnalytics}
              />
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>
      </LayoutSection>

      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>{t("memory.preferences_title")}</LayoutSectionTitle>
          <LayoutSectionDescription>{t("memory.preferences_section_desc")}</LayoutSectionDescription>
        </LayoutSectionHeader>

        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>Cloud Memory Bank preview</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>Show cloud memory management. Requires Sofia Cloud sign-in; this does not enable local memory.</LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <Switch
                aria-label="Cloud Memory Bank preview"
                checked={props.memoryEnabled}
                disabled={props.busy}
                onCheckedChange={props.onToggleMemory}
              />
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>
      </LayoutSection>

    </LayoutStack>
  );
}
