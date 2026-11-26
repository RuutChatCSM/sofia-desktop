import type { AgentPartInput, FilePartInput, TextPartInput } from "@/app/lib/engine-types";
import type { CodexSessionClient } from "@/app/lib/codex-session";
import { SofiaServerError } from "@/app/lib/sofia-server";
import type { ComposerDraft, ComposerPart, ModelRef } from "@/app/types";
import { sanitizePromptText } from "@/lib/embedded-data-urls";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import type { CloudMcpSubmissionResult } from "@/react-app/domains/connections/cloud-mcp-submit-readiness";
import { useComposerStateStore } from "@/react-app/domains/session/surface/composer-state-store";
import { appMentionInstruction } from "@/react-app/domains/session/surface/composer/app-mentions";
import { connectSkillPrompt, parseConnectSkillToken } from "@/react-app/domains/session/surface/composer/connect-skill-token";
import { decodeComposerMentionValue } from "@/react-app/domains/session/surface/composer/mention-encoding";
import { composerAttachmentsToWorkspaceFileParts } from "./attachment-file-part";
import { codexPromptFromParts } from "./codex-prompt-parts";
import { firstLineLocalFileParts, joinWorkspaceRelativePath, toFileUrl } from "./prompt-file-parts";
import { recordSentAttachments } from "./sent-attachment-store";
import { transcriptDisplayParts } from "./transcript-display-parts";
import { isVisibleCodexUserItem, useCodexSessionStore } from "../codex-session-store";

export async function draftToParts(
  draft: ComposerDraft,
  workspaceRoot: string,
  sessionId: string,
  endpoint: ResolvedWorkspaceEndpoint | null,
) {
  const parts: Array<TextPartInput | FilePartInput | AgentPartInput> = [];
  const root = workspaceRoot.trim();

  const toAbsolutePath = (path: string) => {
    const trimmed = path.trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("/")) return trimmed;
    if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return trimmed;
    if (!root) return "";
    return joinWorkspaceRelativePath(root, trimmed);
  };

  const filenameFromPath = (path: string) => {
    const normalized = path.replace(/\\/g, "/");
    const segments = normalized.split("/").filter(Boolean);
    return segments[segments.length - 1] ?? "file";
  };

  const attachmentFileById = new Map<string, FilePartInput>();
  if (draft.attachments.length > 0) {
    if (!endpoint) {
      throw new Error("Workspace endpoint is unavailable; attachments could not be copied for tool access.");
    }
    const uploaded = await composerAttachmentsToWorkspaceFileParts({
      attachments: draft.attachments,
      endpoint,
      sessionId,
      workspaceRoot: root,
    });
    const fileParts = uploaded.filter((part): part is FilePartInput => part.type === "file");
    for (const [index, attachment] of draft.attachments.entries()) {
      const filePart = fileParts[index];
      if (filePart) attachmentFileById.set(attachment.id, filePart);
    }
  }
  const uploadedAttachmentParts = new Map(attachmentFileById);

  // Prefer draft.text token order so attachment chips stay inline with surrounding text
  // (same positions as the composer), instead of dumping every file part at the end.
  const hasAttachmentTokens = /\[attachment [^\]]+\]/.test(draft.text);
  if (hasAttachmentTokens || attachmentFileById.size > 0) {
    const pasteByLabel = new Map(
      draft.parts
        .filter((part): part is Extract<ComposerPart, { type: "paste" }> => part.type === "paste")
        .map((part) => [part.label, part.text] as const),
    );
    for (const segment of draft.text.split(/(\[attachment [^\]]+\]|\[pasted text [^\]]+\]|\[connect-skill [^\]]+\]|\[skill [^\]]+\]|@[^\s@]+)/)) {
      if (!segment) continue;
      const attachmentMatch = segment.match(/^\[attachment (.+)\]$/);
      if (attachmentMatch?.[1]) {
        const attachment = draft.attachments.find((item) => item.id === attachmentMatch[1]);
        if (attachment?.annotationContext) parts.push({ type: "text", text: `\n${attachment.annotationContext}\n` });
        const filePart = attachmentFileById.get(attachmentMatch[1]);
        if (filePart) {
          parts.push(filePart);
          attachmentFileById.delete(attachmentMatch[1]);
        }
        continue;
      }
      const pasteMatch = segment.match(/^\[pasted text (.+)\]$/);
      if (pasteMatch?.[1]) {
        const pasted = pasteByLabel.get(pasteMatch[1]);
        if (pasted) parts.push({ type: "text", text: pasted });
        continue;
      }
      const connectSkill = parseConnectSkillToken(segment);
      if (connectSkill) {
        parts.push({ type: "text", text: connectSkillPrompt(connectSkill) });
        continue;
      }
      const skillMatch = segment.match(/^\[skill (.+)\]$/);
      if (skillMatch?.[1]) {
        parts.push({ type: "text", text: `Load [skill ${skillMatch[1]}] and follow its instructions.` });
        continue;
      }
      if (segment.startsWith("@")) {
        const value = decodeComposerMentionValue(segment.slice(1));
        const mentionPart = draft.parts.find((part) =>
          (part.type === "agent" && part.name === value)
          || (part.type === "app" && part.name === value)
          || (part.type === "file" && part.path === value),
        );
        if (mentionPart?.type === "agent") {
          parts.push({ type: "agent", name: mentionPart.name });
          continue;
        }
        if (mentionPart?.type === "app") {
          parts.push({ type: "text", text: appMentionInstruction(mentionPart.name) });
          continue;
        }
        if (mentionPart?.type === "file") {
          const absolute = toAbsolutePath(mentionPart.path);
          if (!absolute) continue;
          parts.push({
            type: "file",
            mime: "text/plain",
            url: toFileUrl(absolute),
            filename: filenameFromPath(mentionPart.path),
          });
          continue;
        }
      }
      parts.push({ type: "text", text: segment });
    }
    for (const [id, filePart] of attachmentFileById) {
      const context = draft.attachments.find((attachment) => attachment.id === id)?.annotationContext;
      if (context) parts.push({ type: "text", text: `\n${context}\n` });
      parts.push(filePart);
    }
  } else {
    for (const part of draft.parts) {
      if (part.type === "text") {
        parts.push({ type: "text", text: part.text });
        continue;
      }
      if (part.type === "paste") {
        parts.push({ type: "text", text: part.text });
        continue;
      }
      if (part.type === "agent") {
        parts.push({ type: "agent", name: part.name });
        continue;
      }
      if (part.type === "skill") {
        parts.push({ type: "text", text: `Load [skill ${part.name}] and follow its instructions.` });
        continue;
      }
      if (part.type === "app") {
        parts.push({ type: "text", text: appMentionInstruction(part.name) });
        continue;
      }
      if (part.type === "file") {
        const absolute = toAbsolutePath(part.path);
        if (!absolute) continue;
        parts.push({
          type: "file",
          mime: "text/plain",
          url: toFileUrl(absolute),
          filename: filenameFromPath(part.path),
        });
      }
    }
  }

  parts.push(...firstLineLocalFileParts(sanitizePromptText(draft.resolvedText ?? draft.text), root));

  return { parts, uploadedAttachmentParts };
}

type CodexPrompt = (
  sessionId: string,
  text: string,
  selection?: { model?: string; providerId?: string },
  images?: string[],
) => Promise<unknown>;

/**
 * The one codex send path shared by the session route and the browser dock.
 * Composer queue/stop/steer policy stays in `SessionSurface`; this only turns a
 * finalized draft into an engine turn and keeps the optimistic transcript
 * consistent with the echo.
 */
export async function sendCodexDraft(input: {
  draft: ComposerDraft;
  sessionId: string;
  workspaceRoot: string;
  endpoint: ResolvedWorkspaceEndpoint | null;
  model: ModelRef | null | undefined;
  prompt: CodexPrompt;
  steer: CodexSessionClient["steer"] | null;
}): Promise<CloudMcpSubmissionResult> {
  const { draft, sessionId, model } = input;
  // What the model receives, with any encoded binary stripped out.
  const text = sanitizePromptText(draft.resolvedText ?? draft.text).trim();
  // What the user sees optimistically. Display text keeps collapsed
  // pastes collapsed instead of dumping resolved content into the bubble.
  const annotationIds = new Set(draft.attachments.filter((attachment) => attachment.annotationContext).map((attachment) => attachment.id));
  const displayText = draft.text.replace(/\[attachment ([^\]]+)\]/g, (token, id: string) => annotationIds.has(id) ? "" : token).trim();
  if (!text && draft.attachments.length === 0) {
    return { outcome: "cancelled", reason: "context_changed" };
  }
  const selection = {
    model: model?.modelID,
    providerId: model?.providerID,
  };
  const { parts, uploadedAttachmentParts } = await draftToParts(draft, input.workspaceRoot, sessionId, input.endpoint);
  // Never stringify a file part's URL into the prompt: attachment images
  // carry a base64 data URL, which used to land in the turn as a wall of
  // base64. Image payloads ride as structured image inputs instead.
  const composed = codexPromptFromParts(parts);
  const promptText = composed.text || text;
  // Render the user's message immediately; it is dropped once the engine
  // echoes it back as a `userMessage` item. Attachments ride as display parts
  // so an image the user sent is visible in the chat, not just in the
  // composer: the engine's echo is text only.
  const attachmentParts = await transcriptDisplayParts(draft, uploadedAttachmentParts);
  const sessionEntry = useCodexSessionStore.getState().sessions[sessionId];
  const userMessageOrdinal = sessionEntry
    ? sessionEntry.items.filter(isVisibleCodexUserItem).length + sessionEntry.pendingUserMessages.length + (sessionEntry.settledUserMessages?.length ?? 0)
    : undefined;
  // Store by echo ordinal as well as prompt text. Repeated prompts and
  // text-only engine echoes must not move a file to an older message.
  recordSentAttachments(sessionId, promptText, attachmentParts, annotationIds.size ? displayText : undefined, true, userMessageOrdinal);
  useCodexSessionStore.getState().addPendingUserMessage(sessionId, displayText, attachmentParts, promptText, true, userMessageOrdinal);
  try {
    const turnRunning = useCodexSessionStore.getState().sessions[sessionId]?.session.status === "running";
    if (turnRunning && input.steer) {
      const result = await input.steer(sessionId, promptText, composed.images);
      if (result.outcome === "not_steerable" || result.outcome === "turn_mismatch") {
        useCodexSessionStore.getState().confirmPendingUserMessage(sessionId, displayText);
        useComposerStateStore.getState().appendQueuedDraft(sessionId, draft);
        return { outcome: "queued" };
      } else if (result.outcome === "no_active_turn") {
        await input.prompt(sessionId, promptText, selection, composed.images);
      }
    } else {
      await input.prompt(sessionId, promptText, selection, composed.images);
    }
  } catch (error) {
    // No HTTP response (timeout, dropped connection) means the server may still
    // start the turn. Putting the draft back invited a resend and a duplicate
    // turn; keep the optimistic copy until the echo or a turn failure settles it.
    if (!(error instanceof SofiaServerError)) {
      useCodexSessionStore.getState().setWarning(sessionId, "Sofia hasn't confirmed this message yet. It will appear in the conversation once the engine picks it up.");
      return { outcome: "accepted" };
    }
    useCodexSessionStore.getState().confirmPendingUserMessage(sessionId, displayText);
    // Let the composer retain the draft. A rejected follow-up does not stop
    // the active turn and must never disappear silently.
    throw error;
  }
  return { outcome: "accepted" };
}
