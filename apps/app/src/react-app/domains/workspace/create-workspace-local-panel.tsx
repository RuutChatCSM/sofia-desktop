/** @jsxImportSource react */
import {
  ChartNoAxesColumnIncreasing,
  Check,
  FolderPlus,
  Loader2,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { DialogClose, DialogFooter } from "@/components/ui/dialog";
import type { WorkspacePreset } from "../../../app/types";
import { t } from "../../../i18n";
import type { CreateWorkspaceOptions } from "./types";
import {
  errorBannerClass,
  modalBodyClass,
  pillGhostClass,
  pillSecondaryClass,
  sectionBodyClass,
  sectionTitleClass,
  softCardClass,
  surfaceCardClass,
  tagClass,
  warningBannerClass,
} from "./modal-styles";

export type CreateWorkspaceProgressStep = {
  key: string;
  label: string;
  status: "pending" | "active" | "done" | "error";
  detail?: string | null;
};

export type CreateWorkspaceProgressSnapshot = {
  runId: string;
  startedAt: number;
  stage: string;
  error: string | null;
  steps: CreateWorkspaceProgressStep[];
  logs: string[];
};

export type CreateWorkspaceLocalPanelProps = {
  selectedFolder: string | null;
  hasSelectedFolder: boolean;
  pickingFolder: boolean;
  onPickFolder: () => void;
  projectLabel: string;
  onProjectLabelInput: (value: string) => void;
  showProjectLabel: boolean;
  submitting: boolean;
  localError: string | null;
  onClose: () => void;
  onSubmit: () => void;
  confirmLabel?: string;
  workerLabel?: string;
  onConfirmWorker?: (preset: WorkspacePreset, folder: string | null, options?: CreateWorkspaceOptions) => void;
  preset: WorkspacePreset;
  workerSubmitting: boolean;
  workerDisabled: boolean;
  workerDisabledReason: string | null;
  workerCtaLabel?: string;
  workerCtaDescription?: string;
  onWorkerCta?: () => void;
  workerRetryLabel?: string;
  onWorkerRetry?: () => void;
  workerDebugLines: string[];
  progress: CreateWorkspaceProgressSnapshot | null;
  elapsedSeconds: number;
  showProgressDetails: boolean;
  onToggleProgressDetails: () => void;
};

function stepIcon(status: CreateWorkspaceProgressStep["status"]) {
  if (status === "done")
    return <Check size={16} className="text-emerald-10" />;
  if (status === "active")
    return <Loader2 size={16} className="animate-spin text-dls-accent" />;
  if (status === "error") return <XCircle size={16} className="text-red-10" />;
  return <div className="size-4 rounded-full border-2 border-dls-border" />;
}

function toKeyedLines(lines: string[]) {
  let offset = 0;
  return lines.map((line) => {
    const key = `${offset}:${line}`;
    offset += line.length + 1;
    return { key, line };
  });
}

function stepTextClass(status: CreateWorkspaceProgressStep["status"]) {
  if (status === "done") return "text-dls-text font-medium";
  if (status === "active") return "text-dls-text font-semibold";
  if (status === "error") return "text-red-11 font-medium";
  return "text-dls-secondary";
}

export function CreateWorkspaceLocalPanel(
  props: CreateWorkspaceLocalPanelProps,
) {
  const progress = props.progress;
  const hasProjectLabel = props.projectLabel.trim().length > 0;

  return (
    <>
      <div
        className={`${modalBodyClass} transition-opacity duration-300 ${props.submitting ? "pointer-events-none opacity-40" : "opacity-100"}`}
      >
        <div className="space-y-4">
          <button
            type="button"
            onClick={props.onPickFolder}
            disabled={props.pickingFolder || props.submitting}
            className="flex min-h-14 w-full items-center gap-3 rounded-lg border border-dls-border px-3 py-2.5 text-left text-sm transition-colors hover:bg-dls-hover disabled:opacity-50"
          >
            {props.pickingFolder ? <Loader2 size={18} className="shrink-0 animate-spin" /> : <FolderPlus size={18} className="shrink-0 text-dls-secondary" />}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-dls-text">{props.hasSelectedFolder ? props.selectedFolder?.split(/[\\/]/).filter(Boolean).at(-1) : "Choose a folder"}</span>
              {props.hasSelectedFolder ? <span className="block truncate text-xs text-dls-secondary" title={props.selectedFolder ?? undefined}>{props.selectedFolder}</span> : null}
            </span>
            {props.hasSelectedFolder ? <span className="text-xs text-dls-secondary">Change</span> : null}
          </button>
          {props.showProjectLabel ? <details className="text-xs text-dls-secondary" open={hasProjectLabel || undefined}>
            <summary className="w-fit cursor-pointer py-1">Analytics label (optional)</summary>
            <label className="mt-2 block">
              Group this project's activity in analytics
              <input type="text" value={props.projectLabel} onChange={(event) => props.onProjectLabelInput(event.currentTarget.value)} placeholder="Project label" disabled={props.submitting} className="mt-1.5 w-full rounded-md border border-dls-border bg-dls-surface px-3 py-2 text-sm text-dls-text" />
            </label>
          </details> : null}
        </div>
      </div>

    <DialogFooter className="flex-col gap-3">
        {props.submitting && progress ? (
          <div className={softCardClass}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[12px] font-semibold text-dls-text">
                  {progress.error ? (
                    <XCircle size={14} className="text-red-11" />
                  ) : (
                    <Loader2 size={14} className="animate-spin text-dls-accent" />
                  )}
                  Sandbox setup
                </div>
                <div className="mt-1 truncate text-[14px] leading-snug text-dls-text">
                  {progress.stage}
                </div>
                <div className="mt-1 font-mono text-[10px] uppercase tracking-wider text-dls-secondary">
                  {props.elapsedSeconds}s
                </div>
              </div>
              <button
                type="button"
                className={pillGhostClass}
                onClick={props.onToggleProgressDetails}
              >
                {props.showProgressDetails ? "Hide logs" : "Show logs"}
              </button>
            </div>

            {progress.error ? (
              <div className={`mt-3 ${errorBannerClass}`}>{progress.error}</div>
            ) : null}

            <div className="mt-4 grid gap-2.5">
              {progress.steps.map((step) => (
                <div key={step.key} className="flex items-center gap-3">
                  <div className="flex size-5 shrink-0 items-center justify-center">
                    {stepIcon(step.status)}
                  </div>
                  <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
                    <div
                      className={`text-[12px] ${stepTextClass(step.status)} transition-colors duration-200`.trim()}
                    >
                      {step.label}
                    </div>
                    {step.detail?.trim() ? (
                      <div
                        className={`${tagClass} max-w-[120px] truncate font-mono`}
                      >
                        {step.detail}
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>

            {props.showProgressDetails && progress.logs.length > 0 ? (
              <div className={`mt-3 ${softCardClass}`}>
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-dls-secondary">
                  Live logs
                </div>
                <div className="max-h-[120px] space-y-0.5 overflow-y-auto">
                  {toKeyedLines(progress.logs.slice(-10)).map(({ key, line }) => (
                    <div
                      key={`${progress.runId}-log-${key}`}
                      className="break-all font-mono text-[10px] leading-tight text-dls-text"
                    >
                      {line}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {props.onConfirmWorker &&
        props.workerDisabled &&
        props.workerDisabledReason ? (
          <div className={warningBannerClass}>
            <div className="font-semibold text-amber-12">
              {t("dashboard.sandbox_get_ready_title")}
            </div>
            <div className="mt-1 leading-relaxed">
              {props.workerDisabledReason || props.workerCtaDescription}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {props.onWorkerCta && props.workerCtaLabel?.trim() ? (
                <button
                  type="button"
                  className={pillSecondaryClass}
                  onClick={props.onWorkerCta}
                  disabled={props.submitting}
                >
                  {props.workerCtaLabel}
                </button>
              ) : null}
              {props.onWorkerRetry && props.workerRetryLabel?.trim() ? (
                <button
                  type="button"
                  className={pillGhostClass}
                  onClick={props.onWorkerRetry}
                  disabled={props.submitting}
                >
                  {props.workerRetryLabel}
                </button>
              ) : null}
            </div>
            {props.workerDebugLines.length > 0 ? (
              <details
                className={`mt-3 ${softCardClass} text-[11px] text-dls-text`}
              >
                <summary className="cursor-pointer text-[12px] font-semibold text-dls-text">
                  Docker debug details
                </summary>
                <div className="mt-2 space-y-1 break-words font-mono">
                  {toKeyedLines(props.workerDebugLines).map(({ key, line }) => (
                    <div key={`docker-line-${key}`}>{line}</div>
                  ))}
                </div>
              </details>
            ) : null}
          </div>
        ) : null}

        {props.localError ? (
          <div className="mb-3 whitespace-pre-line rounded-[20px] border border-red-7/20 bg-red-1/40 px-4 py-3 text-[13px] text-red-11">
            {props.localError}
          </div>
        ) : null}

        <div className="flex justify-end gap-3">
          <DialogClose
            disabled={props.submitting}
            render={<Button variant="outline" disabled={props.submitting} />}
          >
            {t("common.cancel")}
          </DialogClose>
          {props.onConfirmWorker ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                props.onConfirmWorker?.(props.preset, props.selectedFolder, {
                  projectLabel: props.projectLabel.trim() || null,
                })
              }
              disabled={
                !props.selectedFolder ||
                props.submitting ||
                props.workerSubmitting ||
                props.workerDisabled
              }
              title={
                !props.selectedFolder
                  ? t("dashboard.choose_folder_continue")
                  : props.workerDisabledReason || undefined
              }
            >
              {props.workerSubmitting ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 size={16} className="animate-spin" />
                  {t("dashboard.sandbox_checking_docker")}
                </span>
              ) : (
                (props.workerLabel ??
                  t("dashboard.create_sandbox_confirm"))
              )}
            </Button>
          ) : null}
          <Button
            type="button"
            onClick={() => void props.onSubmit()}
            disabled={!props.selectedFolder || props.submitting}
            title={
              !props.selectedFolder
                ? t("dashboard.choose_folder_continue")
                : undefined
            }
          >
            {props.submitting ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 size={16} className="animate-spin" />
                Creating…
              </span>
            ) : (
              (props.confirmLabel ??
                t("dashboard.create_workspace_confirm"))
            )}
          </Button>
        </div>
    </DialogFooter>
    </>
  );
}
