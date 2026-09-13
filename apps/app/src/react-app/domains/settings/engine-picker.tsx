/** @jsxImportSource react */
import { useState } from "react";
import { Cpu, Sparkles } from "lucide-react";

import { t } from "@/i18n";
import { useSelectedEngine, useSetSelectedEngine, type AgentEngine } from "../session/engine-selection-store";

export type CodexEngineAvailability = {
  available: boolean;
  path: string | null;
  source: string | null;
  pinnedVersion: string | null;
};

export function EnginePicker(props: { codex: CodexEngineAvailability | null }) {
  const engine = useSelectedEngine();
  const setEngine = useSetSelectedEngine();
  const [error, setError] = useState<string | null>(null);

  const select = (next: AgentEngine) => {
    setError(null);
    if (next === "codex" && !props.codex?.available) {
      setError(t("settings.codex_engine_unavailable"));
      return;
    }
    setEngine(next);
  };

  const options: Array<{ value: AgentEngine; icon: typeof Cpu; label: string; desc: string; disabled?: boolean }> = [
    {
      value: "codex",
      icon: Sparkles,
      label: t("settings.codex_engine_label"),
      desc: t("settings.codex_engine_desc"),
      disabled: !props.codex?.available,
    },
    {
      value: "opencode",
      icon: Cpu,
      label: t("settings.opencode_engine_label"),
      desc: t("settings.opencode_engine_switch_desc"),
    },
  ];

  return (
    <div className="space-y-2">
      {options.map((option) => {
        const Icon = option.icon;
        const active = engine === option.value;
        return (
          <button
            key={option.value}
            type="button"
            disabled={option.disabled}
            onClick={() => select(option.value)}
            className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              active
                ? "border-dls-border bg-dls-hover"
                : "border-dls-border bg-dls-surface hover:bg-dls-hover"
            }`}
          >
            <Icon size={18} className="shrink-0 text-dls-secondary" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-dls-text">{option.label}</div>
              <div className="text-[12px] text-dls-secondary">{option.desc}</div>
            </div>
            <span
              className={`h-4 w-4 shrink-0 rounded-full border ${
                active ? "border-dls-primary bg-dls-primary" : "border-dls-border"
              }`}
            />
          </button>
        );
      })}
      {error ? (
        <div className="text-[12px] text-red-11">{error}</div>
      ) : null}
      {engine === "codex" && props.codex ? (
        <div className="pt-1 text-[11px] text-dls-secondary">
          {t("settings.codex_engine_status_line", {
            value: props.codex.available
              ? `${props.codex.pinnedVersion ?? ""}${props.codex.path ? ` · ${props.codex.path}` : ""}`.trim()
              : t("settings.not_available"),
          })}
        </div>
      ) : null}
    </div>
  );
}
