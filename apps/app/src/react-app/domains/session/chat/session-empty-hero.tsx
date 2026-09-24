/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { ArrowRight, X, Zap } from "lucide-react";

import { DEFAULT_MODEL } from "@/app/constants";
import type { ComposerAttachment } from "@/app/types";
import { resolveOrganizationPromptCardContent } from "@/components/chat/task-suggestions";
import { useCheckDesktopRestriction, useOrgRestrictions } from "@/react-app/domains/cloud/desktop-config-provider";
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";
import {
  getSofiaModelsActionUrl,
  hideSofiaModelsPromo,
  isSofiaModelsPromoHidden,
  sofiaModelsPromoChangedEvent,
  useSofiaModelsPromoEligibility,
} from "@/react-app/domains/cloud/sofia-models-promo";
import { usePlatform } from "@/react-app/kernel/platform";
import { NewTaskComposer, type NewTaskComposerContext } from "./new-task-composer";

type HeroSuggestion = {
  title: string;
  description: string;
  prompt: string;
};

const DEFAULT_SUGGESTIONS: HeroSuggestion[] = [
  { title: "Understand this project", description: "An architecture map, grounded in your files.", prompt: "Explore this project and explain its architecture, main entry points, and how the pieces work together. Do not make changes." },
  { title: "Build something", description: "Turn an idea into a working first version.", prompt: "Help me build a new feature in this project. Start by asking what I want to create, then inspect the relevant files." },
  { title: "Find what needs attention", description: "Review changes and investigate problems.", prompt: "/review" },
  { title: "Work with a document", description: "Make a clear draft from your source material.", prompt: "Help me turn source material into a clear document. Ask what I want to create and which files to use." },
];

export type SessionEmptyHeroProps = {
  providerCount: number;
  /** Disable submission while a default workspace is being prepared. */
  busy?: boolean;
  /** Called with the task prompt and attachments; the caller creates the session (and workspace if needed). */
  onRunTask: (prompt: string, attachments: ComposerAttachment[]) => void;
  onOpenProviderAuth?: () => void;
  /** Workspace-scoped wiring for the full composer (skills, agents, models). */
  composer?: NewTaskComposerContext | null;
};

/**
 * Paper "first chat" empty state: the real session composer front and
 * center with suggestion cards below. Suggestions come from desktop
 * policies (organization onboarding prompts) when configured, with
 * built-in defaults otherwise.
 */
export function SessionEmptyHero(props: SessionEmptyHeroProps) {
  const [prompt, setPrompt] = useState("");
  const orgRestrictions = useOrgRestrictions();
  const checkDesktopRestriction = useCheckDesktopRestriction();
  const canAddProviders = !checkDesktopRestriction({ restriction: "allowCustomProviders" });
  const platform = usePlatform();
  const denAuth = useDenAuth();
  const sofiaModelsPromoEligible = useSofiaModelsPromoEligibility();
  const [modelsPromoHidden, setModelsPromoHidden] = useState(isSofiaModelsPromoHidden);

  useEffect(() => {
    const handlePromoChanged = () => setModelsPromoHidden(isSofiaModelsPromoHidden());
    window.addEventListener(sofiaModelsPromoChangedEvent, handlePromoChanged);
    return () => window.removeEventListener(sofiaModelsPromoChangedEvent, handlePromoChanged);
  }, []);

  // Quiet inline lead to Hosted models: replaces the old startup dialog
  // interrupt. Shown only while the session runs on the free starter model
  // (the built-in `engine` provider) and the hosted offering applies.
  const onFreeStarterModel = props.composer?.selectedModel.providerID === DEFAULT_MODEL.providerID;
  const showModelsHint =
    sofiaModelsPromoEligible &&
    !modelsPromoHidden &&
    !props.composer?.sofiaModelsEntitled &&
    onFreeStarterModel;

  const organizationPrompts = orgRestrictions.onboardingPrompts;
  const suggestions: HeroSuggestion[] = organizationPrompts !== undefined
    ? organizationPrompts.map((orgPrompt, index) => {
      const card = resolveOrganizationPromptCardContent({
        prompt: orgPrompt,
        description: orgRestrictions.onboardingPromptDescriptions?.[index],
        index,
      });
      return { title: card.title, description: card.description, prompt: card.selectionPrompt };
    })
    : DEFAULT_SUGGESTIONS;

  const submit = (resolvedPrompt: string, attachments: ComposerAttachment[]) => {
    const trimmedPrompt = resolvedPrompt.trim();
    if (!trimmedPrompt || props.busy) return;
    props.onRunTask(trimmedPrompt, attachments);
  };

  const fillPrompt = (value: string) => {
    setPrompt(value);
    window.dispatchEvent(new Event("sofia:focusPrompt"));
  };

  return (
    <div className="mx-auto w-full max-w-[800px] space-y-5 px-4 sm:px-6">
      <h1 className="flex items-center gap-2.5 text-[15px] font-medium tracking-tight text-foreground">
        <img src="/sofia-mark.svg" alt="" className="sofia-brand-mark size-5" />
        What are we working on?
      </h1>

      <NewTaskComposer
        draft={prompt}
        onDraftChange={setPrompt}
        onRunTask={submit}
        busy={props.busy ?? false}
        context={props.composer ?? null}
      />

      {showModelsHint ? (
        <div
          className="flex items-center justify-center gap-2 text-[12px] text-muted-foreground"
          data-testid="sofia-models-hint"
        >
          <span>Using the free starter model.</span>
          <button
            type="button"
            className="flex items-center gap-1 font-medium text-blue-10 transition-colors hover:text-blue-11"
            onClick={() => platform.openLink(getSofiaModelsActionUrl(denAuth.isSignedIn, "sign-up"))}
          >
            Get frontier models with no API keys
            <ArrowRight className="size-3" />
          </button>
          <button
            type="button"
            className="flex size-5 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:text-foreground"
            onClick={hideSofiaModelsPromo}
            aria-label="Hide Hosted models hint"
          >
            <X className="size-3" />
          </button>
        </div>
      ) : null}

      {!showModelsHint && canAddProviders && props.providerCount === 0 && props.onOpenProviderAuth ? (
        <button
          type="button"
          className="flex w-full items-start gap-3 rounded-xl border border-blue-7/50 bg-blue-2/40 p-3.5 text-left transition-colors hover:bg-blue-3/50"
          onClick={props.onOpenProviderAuth}
        >
          <Zap className="mt-0.5 size-4 shrink-0 text-blue-10" />
          <div>
            <div className="text-[13px] font-medium text-foreground">Connect a model provider</div>
            <div className="mt-0.5 text-[12px] text-muted-foreground">
              Add an API key for Anthropic, OpenAI, Google, or other providers so tasks can run.
            </div>
          </div>
        </button>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion.title}
            type="button"
            title={suggestion.description}
            className="rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-dls-accent"
            onClick={() => fillPrompt(suggestion.prompt)}
          >
            {suggestion.title}
          </button>
        ))}
      </div>
    </div>
  );
}
