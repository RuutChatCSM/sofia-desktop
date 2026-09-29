"use memo";

import * as React from "react"
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Copy,
  Download,
  FileIcon,
  FolderOpen,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Sparkles,
  Split,
  Undo2,
} from "lucide-react"
import { PaperGrainGradient } from "@sofia/ui/react"
import {
  DynamicToolUIPart,
  isFileUIPart,
  ToolUIPart,
  type FileUIPart,
  type UIMessage,
} from "ai"
import type { SessionStatus } from "@/app/lib/engine-types"
import { openDesktopUrl, revealDesktopItemInDir } from "@/app/lib/desktop"
import { isElectronRuntime } from "@/app/lib/runtime-env"
import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX } from "@/app/types"
import { ApplyPatchTool } from "@/components/tools/apply-patch"
import { BackgroundProcessTool } from "@/components/tools/background-process"
import { BashTool } from "@/components/tools/bash"
import { EditTool } from "@/components/tools/edit"
import { EnvVarRequestTool } from "@/components/tools/env-var-request"
import { ReadFileTool, WriteFileTool } from "@/components/tools/file"
import { GlobTool } from "@/components/tools/glob"
import { GrepTool } from "@/components/tools/grep"
import { LspTool } from "@/components/tools/lsp"
import {
  isAutomationProposalToolPart,
  SofiaAutomationProposalTool,
} from "@/components/tools/sofia-automation-proposal"
import { SofiaSessionCreateTool } from "@/components/tools/sofia-session-create"
import { QuestionTool } from "@/components/tools/question"
import { SkillTool } from "@/components/tools/skill"
import { TodoWriteTool } from "@/components/tools/todowrite"
import { WebfetchTool } from "@/components/tools/webfetch"
import { WebsearchTool } from "@/components/tools/websearch"
import { useMessageList, useSessionErrorMessage } from "@/components/chat/message-list-provider"
import { useArtifacts, useOpenArtifactPath } from "@/lib/artifacts"
import { changeSetFromToolHints } from "@/react-app/domains/session/changes/change-set-from-messages"
import { TurnChangeSetCard } from "@/react-app/domains/session/changes/turn-change-set-card"
import {
  selectLatestChangeSetForSession,
  selectTurnChangeSet,
  useChangeSetStore,
} from "@/react-app/domains/session/changes/change-set-store"
import { usePanelTabStore } from "@/react-app/domains/session/panel/panel-tab-store"
import { MESSAGE_REFERENCE_PATTERN, parseMessageReference } from "@/react-app/domains/session/surface/composer/message-reference"
import { messageTurnId, turnAnswerIndex } from "@/components/chat/turn-structure"
import { deriveTurnPresentation, workEntriesForMessage } from "@/components/chat/turn-presentation"
import { recordDevLog } from "@/app/lib/dev-log"
import { liveActivityLabel } from "@/react-app/domains/session/activity"
import { changeSetFiles } from "@/react-app/domains/session/changes/turn-change-set"
import {
  finishedTurnDurationMs,
  resolveTurnTiming,
  turnWorkLabel,
} from "@/components/chat/turn-timing"
import { useSessionActivities } from "@/react-app/domains/session/use-session-activities"
import { ArtifactList } from "@/components/chat/artifact"
import { TaskSuggestions } from "@/components/chat/task-suggestions"
import {
  DescriptiveButtonContent,
  DescriptiveButtonDescription,
  DescriptiveButtonIcon,
  DescriptiveButtonTitle,
} from "@/components/descriptive-button"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { ImageAttachmentBadge } from "@/components/chat/image-attachment-badge"
import { Image } from "@/components/ui/image"
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
} from "@/components/ui/message"
import { Tool } from "@/components/ui/tool"
import { CapabilityCallLine } from "@/components/chat/capability-call-line"
import { hasPreservedMcpAppResult, McpAppFrame } from "@/components/chat/mcp-app-frame"
import { ReasoningBlock } from "@/components/chat/reasoning-block"
import { SubagentRunLine } from "@/components/chat/subagent-run-line"
import { ToolAggregateGroup } from "@/components/chat/tool-aggregate-group"
import {
  isApplyPatchToolPart,
  isBashToolPart,
  isEditToolPart,
  isEnvVarRequestToolPart,
  isGlobToolPart,
  isGrepToolPart,
  isLspToolPart,
  isQuestionToolPart,
  isReadToolPart,
  isSkillToolPart,
  isTaskToolPart,
  isTodoWriteToolPart,
  isWebFetchToolPart,
  isWebSearchToolPart,
  isWriteToolPart,
} from "@/lib/build-in-tools"
import type { ThreadStatus } from "@/lib/messages"
import { formatToolCallDuration } from "@/lib/tool-call-duration"
import { collectLatestAssistantToolParts } from "@/lib/latest-assistant-tool-parts"
import { getActiveToolLabel } from "@/lib/tool-activity"
import { faviconUrlForHref } from "@/lib/favicon"
import { cn } from "@/lib/utils"
import { groupMessages, isMessageGroup, getLastTextPart, getAssistantRenderGroups, getFileTitle, getMediaBadge, getMessageCompleted, getMessageCreated, formatMessageTimestamp, splitTurnAtAnswer, type UIMessageWithIndex, getMessagesText, getSafeFileDownloadUrl, getSafeFileRevealPath } from "./utils"

const SEARCH_HIGHLIGHT_MARK_CLASS = "rounded px-0.5 bg-amber-4/70 text-current"

/** Above this many step rows a finished turn folds into one summary line. */

function MessageTimestamp({ message, className }: { message: UIMessage; className?: string }) {
  const created = getMessageCreated(message)
  if (created === null) return null

  return (
    <span
      className={cn(
        "select-none whitespace-nowrap text-[11px] tabular-nums text-muted-foreground/70",
        className
      )}
      title={new Date(created).toLocaleString()}
    >
      {formatMessageTimestamp(created)}
    </span>
  )
}

interface ToolMessageProps {
  part: ToolUIPart | DynamicToolUIPart
}

/**
 * Error boundary around tool-part rendering. Tool inputs from streamed or
 * interrupted runs can violate their type contracts (partial/undefined
 * input); without this boundary a single bad part unmounts the entire app
 * (white screen). Seen in production on v0.15.3 via a todowrite part with
 * missing input.todos.
 */
class ToolMessage extends React.Component<ToolMessageProps, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown) {
    console.error("[tool-part] render failed", error)
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="text-xs text-muted-foreground">Tool step unavailable</div>
      )
    }
    return <ToolMessageInner part={this.props.part} />
  }
}

const ToolMessageInner = ({ part }: ToolMessageProps) => {
  const { onMcpReconnect, onMcpReopenAuthorization, onMcpRetry, developerMode } = useMessageList()

  if (isBashToolPart(part)) {
    return <BashTool part={part} />
  }

  if (isEditToolPart(part)) {
    return <EditTool part={part} />
  }

  if (isWriteToolPart(part)) {
    return <WriteFileTool part={part} />
  }

  if (isReadToolPart(part)) {
    return <ReadFileTool part={part} />
  }

  if (isGrepToolPart(part)) {
    return <GrepTool part={part} />
  }

  if (isGlobToolPart(part)) {
    return <GlobTool part={part} />
  }

  if (isLspToolPart(part)) {
    return <LspTool part={part} />
  }

  if (isApplyPatchToolPart(part)) {
    return <ApplyPatchTool part={part} />
  }

  if (isSkillToolPart(part)) {
    return <SkillTool part={part} />
  }

  if (isTodoWriteToolPart(part)) {
    return <TodoWriteTool part={part} />
  }

  if (isWebFetchToolPart(part)) {
    return <WebfetchTool part={part} />
  }

  if (isWebSearchToolPart(part)) {
    return <WebsearchTool part={part} />
  }

  if (isQuestionToolPart(part)) {
    return <QuestionTool part={part} />
  }

  if (isEnvVarRequestToolPart(part)) {
    return <EnvVarRequestTool part={part} />
  }

  if (part.type === "dynamic-tool" && part.toolName === "sofia_session_create") {
    return <SofiaSessionCreateTool part={part} />
  }

  if (part.type === "dynamic-tool" && part.toolName === "background_process") {
    // The transcript speaks in activities ("✦ Running the app tests"), so the
    // terminal command card is a developer detail, not the default reading.
    // Everyone else reaches it from the Activity drawer's Details.
    return developerMode ? <BackgroundProcessTool part={part} /> : null
  }

  if (part.type === "dynamic-tool" && isAutomationProposalToolPart(part)) {
    return <SofiaAutomationProposalTool part={part} />
  }

  if (isTaskToolPart(part)) {
    return <SubagentRunLine part={part} />
  }

  // Failed calls use the same sentence line with the "failures are
  // instructions" treatment (inline Reconnect/Retry).
  if (part.type === "dynamic-tool") {
    return (
      <CapabilityCallLine
        part={part}
        onReconnect={onMcpReconnect}
        onReopenAuthorization={onMcpReopenAuthorization}
        onRetry={onMcpRetry}
      />
    )
  }

  return (
    <Tool
      toolPart={part}
      onReconnect={onMcpReconnect}
      onReopenAuthorization={onMcpReopenAuthorization}
      onRetry={onMcpRetry}
    />
  )
}

const isEmptyMessage = (message: UIMessage): boolean => message.parts.length === 0

type RetryStatus = Extract<SessionStatus, { type: "retry" }>

function isSessionErrorMessage(message: UIMessage) {
  return message.id.startsWith(SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX)
}

function retryDelaySeconds(status: RetryStatus) {
  return Math.max(0, Math.round((status.next - Date.now()) / 1000))
}

interface FileMessageProps {
  part: FileUIPart
  tone: "user" | "assistant"
}

function FileMessage({ part, tone }: FileMessageProps) {
  const title = getFileTitle(part)
  const badge = getMediaBadge(part)
  const isImage = part.mediaType.startsWith("image/") && Boolean(part.url)
  const downloadUrl = getSafeFileDownloadUrl(part)
  const revealPath = getSafeFileRevealPath(part)
  const canReveal = isElectronRuntime() && Boolean(revealPath)

  const handleDownload = React.useCallback(() => {
    if (!downloadUrl) return
    const anchor = document.createElement("a")
    anchor.href = downloadUrl
    anchor.download = title
    anchor.rel = "noopener noreferrer"
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
  }, [downloadUrl, title])

  const handleReveal = React.useCallback(() => {
    if (!revealPath) return
    void revealDesktopItemInDir(revealPath)
  }, [revealPath])

  if (isImage && tone === "user") {
    return <ImageAttachmentBadge src={part.url} alt={title} />
  }

  if (isImage) {
    return (
      <Image
        src={part.url}
        alt={title}
        loading="lazy"
        decoding="async"
        previewMaxWidth={280}
        previewMaxHeight={160}
        className="rounded-xl border border-border/70"
      />
    )
  }

  return (
    <div className="flex h-auto w-fit min-w-0 max-w-full shrink items-center justify-start gap-2 rounded-xl border border-border/70 bg-background/40 ps-2 pe-2 py-1 text-left text-sm font-medium whitespace-normal">
      <div className="flex min-w-0 items-center gap-2 pe-2">
        <DescriptiveButtonIcon>
          <FileIcon className="size-5 shrink-0" />
        </DescriptiveButtonIcon>
        <DescriptiveButtonContent className="gap-0">
          <DescriptiveButtonTitle className="truncate text-xs">{title}</DescriptiveButtonTitle>
          {badge ? (
            <DescriptiveButtonDescription className="text-[10px]">
              {badge}
            </DescriptiveButtonDescription>
          ) : null}
        </DescriptiveButtonContent>
      </div>
      {downloadUrl || canReveal ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`More actions for ${title}`}
              >
                <MoreHorizontal />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="min-w-44">
            {downloadUrl ? (
              <DropdownMenuItem onClick={handleDownload}>
                <Download />
                Download
              </DropdownMenuItem>
            ) : null}
            {canReveal ? (
              <DropdownMenuItem onClick={handleReveal}>
                <FolderOpen />
                Reveal in Finder
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  )
}

interface CopyMessageButtonProps {
  messages: UIMessage[]
}

function CopyMessageButton({ messages }: CopyMessageButtonProps) {
  const [copied, setCopied] = React.useState(false)
  const text = React.useMemo(() => getMessagesText(messages), [messages])

  const onCopy = React.useCallback(async () => {
    if (!text) {
      return
    }

    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // ignore clipboard failures
    }
  }, [text])

  if (!text) {
    return null
  }

  return (
    <MessageAction tooltip={copied ? "Copied!" : "Copy"}>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Copy message"
        onClick={() => void onCopy()}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </MessageAction>
  )
}

type AssistantMessageProps = {
  message: UIMessage
  isLastMessage: boolean
  isStreaming: boolean
  isLastStep: boolean
  /** Set when the turn's collapsed step run shows this reasoning instead. */
  hideReasoning?: boolean
}

/**
 * The parts of one assistant message, with no transcript wrapper.
 *
 * Split out of `AssistantMessage` so the work disclosure can render tool detail
 * without giving every entry normal chat-message structure. A WorkBlock holding a
 * dozen progress updates must not be a dozen little transcript messages.
 */
const AssistantParts = React.memo(
  ({ message, isStreaming, hideReasoning }: Omit<AssistantMessageProps, "isLastMessage" | "isLastStep">) => {
    const { showThinking, highlightQuery } = useMessageList()
    const assistantRenderGroups = React.useMemo(
      () => {
        const groups = getAssistantRenderGroups(message.parts, showThinking)
        return hideReasoning ? groups.filter((group) => group.kind !== "reasoning") : groups
      },
      [hideReasoning, message.parts, showThinking]
    )

    return (
      <div className="group flex w-full flex-col gap-0 space-y-2">
        {assistantRenderGroups.map((group, index) => {
            if (group.kind === "text") {
              return (
                <MessageContent
                  key={`text-${index}`}
                  className="text-foreground prose w-full min-w-0 flex-1 rounded-lg bg-transparent p-0"
                  markdown
                  isStreaming={isStreaming}
                  highlightQuery={highlightQuery}
                >
                  {group.text}
                </MessageContent>
              )
            }

            if (group.kind === "reasoning") {
              return (
                <ReasoningBlock
                  key={`reasoning-${index}`}
                  text={group.text}
                  isStreaming={group.isStreaming}
                />
              )
            }

            if (group.kind === "file") {
              return (
                <div key={`file-${index}`} className="w-fit max-w-full">
                  <FileMessage part={group.part} tone="assistant" />
                </div>
              )
            }

            if (group.kind === "tool-aggregate") {
              return (
                <div key={`tool-aggregate-${index}`} className="w-full">
                  <ToolAggregateGroup parts={group.parts} />
                </div>
              )
            }

            return (
              <div key={`tool-${index}`} className="w-full">
                <ToolMessage part={group.part} />
              </div>
            )
        })}
      </div>
    )
  }
)

AssistantParts.displayName = "AssistantParts"

const AssistantMessage = React.memo(
  ({ message, isStreaming, hideReasoning }: AssistantMessageProps) => {
    return (
      <Message
        className="mx-auto flex w-full max-w-[800px] flex-col items-start gap-2 px-2 md:px-6"
        data-message-id={message.id}
        data-message-role={message.role}
      >
        <AssistantParts message={message} isStreaming={isStreaming} hideReasoning={hideReasoning} />
      </Message>
    )
  }
)

AssistantMessage.displayName = "AssistantMessage"

type UserMessageProps = {
  message: UIMessage
  isStreaming: boolean
}

const USER_SKILL_TOKEN_RE = /(Load \[skill [^\]]+\] and follow its instructions\.|\[skill [^\]]+\])/

function UserSkillChip(props: { name: string }) {
  return (
    <span className="mx-0.5 inline-flex items-center rounded-full border border-violet-6/35 bg-violet-3/20 px-2.5 py-1 text-xs font-medium text-violet-11 align-middle" title={`Skill: ${props.name}`}>
      {props.name}
    </span>
  )
}

function renderPlainTextWithSearchHighlights(text: string, highlightQuery: string | undefined, keyPrefix: string) {
  const needle = highlightQuery?.trim().toLowerCase() ?? ""
  if (needle.length < 2) return text

  const lower = text.toLowerCase()
  if (!lower.includes(needle)) return text

  const nodes: React.ReactNode[] = []
  let cursor = 0
  let matchIndex = lower.indexOf(needle)
  while (matchIndex >= 0) {
    if (matchIndex > cursor) {
      nodes.push(text.slice(cursor, matchIndex))
    }
    const end = matchIndex + needle.length
    nodes.push(
      <mark
        key={`${keyPrefix}:match:${matchIndex}`}
        data-search-highlight="true"
        className={SEARCH_HIGHLIGHT_MARK_CLASS}
      >
        {text.slice(matchIndex, end)}
      </mark>
    )
    cursor = end
    matchIndex = lower.indexOf(needle, cursor)
  }

  if (cursor < text.length) {
    nodes.push(text.slice(cursor))
  }

  return nodes
}

// Bare URL, excluding trailing punctuation that usually ends a sentence.
const PLAIN_URL_RE = /https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/g

/** User bubbles are plain text, so bare https:// URLs need explicit anchors. */
function renderPlainTextWithLinks(text: string, highlightQuery: string | undefined, keyPrefix: string) {
  const nodes: React.ReactNode[] = []
  let cursor = 0
  for (const match of text.matchAll(PLAIN_URL_RE)) {
    const start = match.index
    const url = match[0]
    if (start > cursor) {
      nodes.push(
        <React.Fragment key={`${keyPrefix}:pre:${cursor}`}>
          {renderPlainTextWithSearchHighlights(text.slice(cursor, start), highlightQuery, `${keyPrefix}:pre:${cursor}`)}
        </React.Fragment>
      )
    }
    const favicon = faviconUrlForHref(url)
    nodes.push(
      <a
        key={`${keyPrefix}:url:${start}`}
        href={url}
        target="_blank"
        rel="noreferrer noopener"
        className="text-indigo-10 transition-colors hover:text-indigo-8 break-all"
      >
        {favicon ? (
          <img
            src={favicon}
            alt=""
            aria-hidden="true"
            loading="lazy"
            decoding="async"
            className="me-1 inline-block size-3.5 rounded-[3px] align-[-2px]"
          />
        ) : null}
        {url}
      </a>
    )
    cursor = start + url.length
  }
  if (nodes.length === 0) return renderPlainTextWithSearchHighlights(text, highlightQuery, keyPrefix)
  if (cursor < text.length) {
    nodes.push(
      <React.Fragment key={`${keyPrefix}:post:${cursor}`}>
        {renderPlainTextWithSearchHighlights(text.slice(cursor), highlightQuery, `${keyPrefix}:post:${cursor}`)}
      </React.Fragment>
    )
  }
  return nodes
}

function renderUserTextWithSkillChips(text: string, highlightQuery: string | undefined): React.ReactNode {
  const matches = [...text.matchAll(MESSAGE_REFERENCE_PATTERN)]
  if (!matches.length) return renderUserTextWithoutReferences(text, highlightQuery)
  const nodes: React.ReactNode[] = []
  let cursor = 0
  for (const match of matches) {
    const reference = parseMessageReference(match[0])
    if (!reference) continue
    nodes.push(<React.Fragment key={`before-${match.index}`}>{renderUserTextWithoutReferences(text.slice(cursor, match.index), highlightQuery)}</React.Fragment>)
    nodes.push(
      <span key={`reference-${match.index}`} title={reference.path} data-message-reference={reference.kind}
        className="mx-1 inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-background/40 px-2.5 py-0.5 align-middle text-sm">
        {reference.kind === "file" ? <FileIcon className="size-3.5 shrink-0" /> : <FolderOpen className="size-3.5 shrink-0" />}
        <span className="break-all">{reference.label}</span>
      </span>,
    )
    cursor = match.index + match[0].length
  }
  nodes.push(<React.Fragment key="remaining">{renderUserTextWithoutReferences(text.slice(cursor), highlightQuery)}</React.Fragment>)
  return nodes
}

function renderUserTextWithoutReferences(text: string, highlightQuery: string | undefined) {
  if (!USER_SKILL_TOKEN_RE.test(text)) return renderPlainTextWithLinks(text, highlightQuery, "text")
  let offset = 0
  return text.split(USER_SKILL_TOKEN_RE).map((segment) => {
    const key = `${offset}:${segment}`
    offset += segment.length
    const skillMatch = segment.match(/^(?:Load )?\[skill ([^\]]+)\](?: and follow its instructions\.)?$/)
    if (skillMatch?.[1]) return <UserSkillChip key={key} name={skillMatch[1]} />
    return <React.Fragment key={key}>{renderPlainTextWithLinks(segment, highlightQuery, key)}</React.Fragment>
  })
}

const UserMessage = React.memo(
  ({ message, isStreaming }: UserMessageProps) => {
    const { onRevertToUserMessage, onForkAtMessage, onEditUserMessage, highlightQuery } = useMessageList()
    const messageText = React.useMemo(() => getMessagesText([message]), [message])
    const inlineParts = React.useMemo(
      () => message.parts.filter((part) => (part.type === "text" && Boolean(part.text)) || isFileUIPart(part)),
      [message.parts],
    )
    const hasContent = inlineParts.length > 0

    return (
      <Message
        className="mx-auto flex w-full max-w-[800px] flex-col items-end gap-2 px-2 md:px-6"
        data-message-id={message.id}
        data-message-role={message.role}
      >
        <ContextMenu>
          <ContextMenuTrigger
            // Override Trigger's select-none so user bubbles stay copyable.
            className="!select-text"
            render={
              <div
                className="group flex w-full flex-col items-end gap-1 !select-text"
                style={{ userSelect: "text" }}
              >
                {hasContent ? (
                  <MessageContent
                    className="bg-muted text-foreground max-w-[85%] rounded-3xl px-4 py-2.5 leading-6 sm:max-w-[75%] !select-text not-prose"
                    style={{ userSelect: "text" }}
                  >
                    {inlineParts.map((part, index) => {
                      if (part.type === "text") {
                        return (
                          <span key={`text-${index}`} className="whitespace-pre-wrap">
                            {renderUserTextWithSkillChips(part.text, highlightQuery)}
                          </span>
                        )
                      }
                      if (isFileUIPart(part)) {
                        return (
                          <span
                            key={`file-${part.url}-${index}`}
                            className="mx-1 inline-flex align-middle not-prose"
                          >
                            <FileMessage part={part} tone="user" />
                          </span>
                        )
                      }
                      return null
                    })}
                  </MessageContent>
                ) : null}
                {!isStreaming && (
                  <MessageActions
                    className={cn(
                      "flex items-center gap-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100 max-lg:opacity-100 pointer-coarse:opacity-100"
                    )}
                  >
                    <MessageTimestamp message={message} className="mr-1.5" />
                    <CopyMessageButton messages={[message]} />
                    {messageText ? (
                      <MessageAction tooltip="Edit message">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Edit message"
                          onClick={() => onEditUserMessage(message.id, messageText)}
                        >
                          <Pencil />
                        </Button>
                      </MessageAction>
                    ) : null}
                    <MessageAction tooltip="Branch in new chat">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Branch in new chat"
                        onClick={() => onForkAtMessage(message.id)}
                      >
                        <Split className="rotate-90" />
                      </Button>
                    </MessageAction>
                    <MessageAction tooltip="Revert">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Revert"
                        onClick={() => onRevertToUserMessage(message.id)}
                      >
                        <Undo2 />
                      </Button>
                    </MessageAction>
                  </MessageActions>
                )}
              </div>
            }
          />
          <ContextMenuContent className="w-56">
            {messageText ? (
              <ContextMenuItem onClick={() => onEditUserMessage(message.id, messageText)}>
                <Pencil className="size-4" />
                Edit message
              </ContextMenuItem>
            ) : null}
            {messageText ? (
              <ContextMenuItem onClick={() => void navigator.clipboard.writeText(messageText)}>
                <Copy className="size-4" />
                Copy
              </ContextMenuItem>
            ) : null}
            <ContextMenuItem onClick={() => onForkAtMessage(message.id)}>
              <Split className="size-4 rotate-90" />
              Branch in new chat
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onRevertToUserMessage(message.id)}>
              <Undo2 className="size-4" />
              Revert
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </Message>
    )
  }
)

UserMessage.displayName = "UserMessage"

type MessageComponentProps = {
  message: UIMessage
  isLastMessage: boolean
  isStreaming: boolean
  isLastStep: boolean
  hideReasoning?: boolean
}

const MessageComponent = React.memo(
  ({ message, isLastMessage, isStreaming, isLastStep, hideReasoning }: MessageComponentProps) => {
    if (isSessionErrorMessage(message)) {
      return <ErrorMessage error={getMessagesText([message]) || "Session failed"} />
    }

    if (isEmptyMessage(message)) {
      return null
    }

    if (message.role === "assistant") {
      return (
        <AssistantMessage
          message={message}
          isLastMessage={isLastMessage}
          isStreaming={isStreaming}
          isLastStep={isLastStep}
          hideReasoning={hideReasoning}
        />
      )
    }

    return (
      <UserMessage
        message={message}
        isStreaming={isStreaming}
      />
    )
  }
)

MessageComponent.displayName = "MessageComponent"

const LoadingMessage = React.memo(({ label }: { label?: string }) => (
  <Message className="mx-auto flex w-full max-w-[800px] flex-col items-start gap-2 px-2 md:px-6">
    <div className="group flex w-full flex-col gap-0">
      <div className="flex items-center gap-1.5 px-1 py-1 text-sm text-muted-foreground">
        {label ? (
          <Sparkles className="size-3.5 shrink-0 text-foreground/70" aria-hidden="true" />
        ) : (
          <span className="sofia-working-dot" aria-hidden="true" />
        )}
        {/* The semantic phase ("Running the app tests") is what tells the user
            what is happening; the shimmer only says it is still in progress.
            "Sofia is working…" is the rare no-title fallback. */}
        <span className={label ? "ow-text-shimmer font-medium" : undefined}>{label ?? "Sofia is working…"}</span>
      </div>
    </div>
  </Message>
))

LoadingMessage.displayName = "LoadingMessage"

interface ErrorMessageProps {
  error: string | null
}

function ErrorMessage({ error }: ErrorMessageProps) {
  return (
    <Message className="not-prose mx-auto flex w-full max-w-[800px] flex-col items-start gap-2 px-2 md:px-6">
      <div className="group flex w-full flex-col items-start gap-0">
        <div className="text-foreground flex min-w-0 flex-1 flex-row items-start gap-2 rounded-lg border-2 border-red-300 bg-red-300/20 px-2 py-1">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-destructive" />
          <p className="whitespace-pre-wrap text-destructive">{error}</p>
        </div>
      </div>
    </Message>
  )
}

interface RetryMessageProps {
  status: RetryStatus
}

function RetryActionButton(props: { link: string; label: string }) {
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-7 border-amber-500/70 bg-amber-50 text-xs text-amber-950 hover:bg-amber-100"
      onClick={() => void openDesktopUrl(props.link)}
    >
      {props.label}
    </Button>
  )
}

const RetryMessage = React.memo(({ status }: RetryMessageProps) => {
  const [seconds, setSeconds] = React.useState(() => retryDelaySeconds(status))

  React.useEffect(() => {
    const update = () => setSeconds(retryDelaySeconds(status))
    update()
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [status])

  const info = seconds > 0
    ? `Retrying in ${seconds}s · attempt ${status.attempt}`
    : `Retrying · attempt ${status.attempt}`
  const action = status.action

  return (
    <Message className="not-prose mx-auto flex w-full max-w-[800px] flex-col items-start gap-2 px-2 md:px-6">
      <div className="group flex w-full flex-col items-start gap-0">
        <div className="text-foreground flex min-w-0 flex-1 flex-col gap-2 rounded-lg border-2 border-amber-300 bg-amber-300/20 px-3 py-2">
          <div className="flex items-start gap-2">
            <LoaderCircle size={16} className="mt-0.5 shrink-0 animate-spin text-amber-700" />
            <div className="min-w-0 space-y-1">
              <p className="whitespace-pre-wrap text-sm font-medium text-amber-900">{status.message}</p>
              <p className="text-xs text-amber-800">{info}</p>
            </div>
          </div>
          {action ? (
            <div className="ml-6 space-y-1 border-t border-amber-400/60 pt-2">
              <p className="text-xs font-medium text-amber-950">{action.title}</p>
              <p className="text-xs text-amber-900">{action.message}</p>
              {action.link ? (
                <RetryActionButton link={action.link} label={action.label} />
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </Message>
  )
})

RetryMessage.displayName = "RetryMessage"

const isMessageEmptyGroup = (messages: UIMessageWithIndex[]) =>
  messages.every(message => isEmptyMessage(message.message));

const getRenderableMessages = (messages: UIMessageWithIndex[]) =>
  messages.flatMap((item) => {
    const renderableMessage = getRenderableMessage(item.message);

    return renderableMessage ? [{ ...item, message: renderableMessage }] : []
  })

function getRenderableMessage(message: UIMessage) {
  const parts = message.parts.filter((part) => part.type === "text" || part.type === "file");

  return parts.length > 0 ? { ...message, parts } : null;
}

/**
 * One work unit per assistant turn.
 *
 * A turn can contain dozens of engine items — reasoning, tool calls, edits,
 * subagent runs — and those are transport boundaries, not UX boundaries.
 * Rendering each one as its own row made a long turn explode vertically
 * ("Thought, Thought, Thought…"). The whole turn is therefore one collapsible
 * object holding its entire narrative: commentary, aggregated tool milestones,
 * and tool/reasoning detail, in the order they happened.
 *
 * Open while the turn runs, because then the work *is* the transcript. When the
 * final answer arrives the same block becomes "Worked for …" and collapses, so
 * the transcript settles into a record of outcomes; expanding it restores the
 * narrative exactly as it streamed.
 */
function TurnWorkBlock({
  label,
  active,
  streaming,
  elapsedMs,
  defaultOpen,
  children,
}: {
  label: string
  active: boolean
  streaming: boolean
  elapsedMs: number | null
  defaultOpen: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = React.useState(defaultOpen)
  // Follow the turn's lifecycle rather than only its first render: `active` flips
  // when the answer lands, which is exactly when the trail should fold away. A
  // manual toggle in between survives, because `defaultOpen` does not change again
  // until the turn's own state does.
  React.useEffect(() => {
    setOpen(defaultOpen)
  }, [defaultOpen])

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex w-full flex-col gap-2">
      <div className="mx-auto flex w-full max-w-[800px] px-2 md:px-6">
        <CollapsibleTrigger
          className="group flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          aria-label={open ? `${label}. Hide work` : `${label}. Show work`}
          data-turn-work-header={active ? "active" : "done"}
        >
          {active ? (
            <Sparkles
              aria-hidden="true"
              className={cn("size-3.5 shrink-0 text-foreground/70", streaming && "animate-pulse")}
            />
          ) : null}
          <span className={cn("truncate", streaming && "ow-text-shimmer font-medium")}>{label}</span>
          {active && elapsedMs !== null && elapsedMs >= 1000 ? (
            <span className="shrink-0 tabular-nums text-muted-foreground/70">
              {formatToolCallDuration(elapsedMs)}
            </span>
          ) : null}
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150",
              open && "rotate-90"
            )}
          />
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-150 ease-out data-starting-style:h-0 data-ending-style:h-0 [&[hidden]:not([hidden='until-found'])]:hidden">
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * A row inside the work disclosure.
 *
 * Deliberately not `Message`/`MessageComponent`: those give a row normal
 * transcript-message structure — a wide container, its own vertical rhythm — which
 * is right for the turn's answer and wrong for the dozen progress updates inside
 * one disclosure. Work rows are compact and belong to the narrative.
 */
function WorkRow({
  kind,
  children,
}: {
  kind: "commentary" | "thought" | "milestone" | "detail"
  children: React.ReactNode
}) {
  return (
    <div data-work-entry={kind} className="mx-auto w-full max-w-[800px] px-2 md:px-6">
      {children}
    </div>
  )
}

/**
 * Progress prose inside the disclosure: the words, not a message.
 *
 * Markdown only. No message shell and no per-message spacing — a dozen progress
 * updates inside one disclosure must not be a dozen little transcript messages.
 * Reasoning is the one thing here that keeps its own collapsed control: it is
 * the detail behind the narrative rather than part of it.
 */
function WorkProse({
  kind,
  message,
  text,
  isStreaming,
}: {
  kind: "commentary"
  message?: UIMessage
  text?: string
  isStreaming?: boolean
}) {
  const { highlightQuery } = useMessageList()
  const value = text ?? getMessagesText(message ? [message] : [])
  if (!value.trim()) return null

  return (
    <WorkRow kind={kind}>
      <MessageContent
        markdown
        isStreaming={Boolean(isStreaming)}
        highlightQuery={highlightQuery}
        className={cn(
          "prose w-full min-w-0 bg-transparent p-0 text-[13px] leading-6 text-foreground/90",
        )}
      >
        {value}
      </MessageContent>
    </WorkRow>
  )
}

/**
 * One line for the turn on screen, so "do tools aggregate?" is read off the
 * presentation instead of inferred from a screenshot: `tools=12 milestones=0`
 * means the run never collapsed, `milestones=2` with nothing visible means the
 * renderer dropped it. Deduped by shape, so it reports when the mix changes
 * rather than on every streamed token.
 *
 * Temporary: remove once the work block is settled.
 */
let lastPresentationLog = ""

function logPresentation(input: {
  turnId: string
  commentary: number
  reasoning: number
  thoughts: number
  tools: number
  milestones: number
  answers: number
}): void {
  if (!import.meta.env.DEV) return
  const line = [
    `turn=${input.turnId}`,
    `commentary=${input.commentary}`,
    `reasoning=${input.reasoning}`,
    `thoughts=${input.thoughts}`,
    `tools=${input.tools}`,
    `milestones=${input.milestones}`,
    `answers=${input.answers}`,
  ].join(" ")
  if (line === lastPresentationLog) return
  lastPresentationLog = line
  console.info(`[presentation] ${line}`)
  recordDevLog(true, { level: "debug", source: "presentation", label: line })
}

/** Ticks while a turn is live so its header can show elapsed work time. */
function useLiveElapsed(startedAt: number | null, active: boolean): number | null {
  const [now, setNow] = React.useState(() => Date.now())

  React.useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])

  if (startedAt === null || !active) return null
  return Math.max(0, now - startedAt)
}

/**
 * Whether a turn group already has visible work. When it does, the generic
 * "Sofia is working…" fallback must stay out of the transcript: the work block
 * header is the single live-progress line.
 */
function groupHasWork(items: UIMessageWithIndex[], showThinking: boolean): boolean {
  return items.some(
    (item) =>
      item.message.role === "assistant"
      && !isSessionErrorMessage(item.message)
      && getAssistantRenderGroups(item.message.parts, showThinking).some((group) => group.kind !== "text")
  )
}

interface AssistantMessageGroupProps {
  items: UIMessageWithIndex[]
  messages: UIMessage[]
  isStreaming: boolean
  /** Semantic Activity title for the live turn, e.g. "Running the app tests". */
  activeLabel?: string | null
}

function collectMcpAppParts(items: UIMessageWithIndex[]): DynamicToolUIPart[] {
  const parts = new Map<string, DynamicToolUIPart>()
  for (const item of items) {
    if (item.message.role !== "assistant" || isSessionErrorMessage(item.message)) continue
    for (const part of item.message.parts) {
      if (
        part.type === "dynamic-tool"
        && (part.state === "output-available" || part.state === "output-error")
        && hasPreservedMcpAppResult(part)
      ) {
        parts.set(part.toolCallId, part)
      }
    }
  }
  return [...parts.values()]
}

function MessageGroup({
  items,
  messages,
  isStreaming,
  activeLabel,
}: AssistantMessageGroupProps) {
  const { sessionId, onRevertToUserMessage, onForkAtMessage, showThinking } = useMessageList()
  const lastItem = items[items.length - 1]
  // Branch/revert must target a real server-side message id. Synthetic
  // client-side messages (e.g. session errors) don't exist on the server and
  // silently corrupt fork/revert boundaries.
  const lastRealItem = items.findLast((item) => !isSessionErrorMessage(item.message))
  const isLiveGroup = isStreaming && lastItem !== undefined && lastItem.index === messages.length - 1
  // Timing belongs to the whole logical turn — narration, an earlier premature
  // answer, resumed work and the trailing answer all count (see turn-timing.ts).
  // The ticking clock is a hook, so it must run before the early return below.
  const timing = resolveTurnTiming(items.map((item) => item.message))
  const liveElapsedMs = useLiveElapsed(timing.startedAt, isLiveGroup)
  // What the turn changed, as its own durable object — separate from what it did
  // (the work block) and from what Sofia is doing now (Activity). Hints only for
  // now: there is no repository-backed producer yet, so this is explicitly
  // `source: "tool-events"` and carries no line counts.
  const turnArtifacts = useArtifacts(items.map((item) => item.message), { includeTargetFallbacks: false })
  const openArtifactPath = useOpenArtifactPath()
  const turnId = items[0] ? messageTurnId(items[0].message) ?? items[0].message.id : null
  const hintChangeSet = React.useMemo(
    () =>
      turnId
        ? changeSetFromToolHints({
            sessionId,
            turnId,
            startedAt: timing.startedAt ?? 0,
            paths: turnArtifacts.map((artifact) => artifact.path),
          })
        : null,
    [sessionId, timing.startedAt, turnArtifacts, turnId],
  )
  // Never borrow another turn's edits for a new reply, even while its own set is loading.
  const repoChangeSet = useChangeSetStore((state) =>
    selectTurnChangeSet(state.byId, sessionId, turnId)

  )
  // A repository-backed set (git) is authoritative — but only when it actually
  // found something. An empty read is what a turn that *commits* its work looks
  // like from the working tree, and letting that empty set win hid the card for a
  // turn that plainly changed files; the hints are better than nothing there.
  const changeSet =
    repoChangeSet && changeSetFiles(repoChangeSet).length > 0 ? repoChangeSet : hintChangeSet
  // Keyed by content, not object identity: the hint set is rebuilt on every
  // render, and depending on the object made this effect (and therefore a store
  // write, and therefore a render) fire forever.
  const hintChangeSetKey = hintChangeSet
    ? `${hintChangeSet.id}|${hintChangeSet.repositories[0]?.files.map((file) => file.path).join(",") ?? ""}`
    : null
  React.useEffect(() => {
    // Register a hint-sourced set so Review can open it by id. Without this the
    // pane looked up an id that was never stored and reported "0 files" beside a
    // card that claimed six.
    if (!hintChangeSet) return
    useChangeSetStore.getState().upsert(hintChangeSet)
  }, [hintChangeSetKey])

  if (!lastItem || isMessageEmptyGroup(items)) {
    return null;
  }

  const renderableItems = getRenderableMessages(items)
  const lastTextMessage = getLastTextPart(lastItem.message)
  const mcpAppParts = collectMcpAppParts(items)

  // Sofia emits narration, reasoning, and tool calls as separate items.
  // Every one of those is the turn's work, including `phase: "commentary"`
  // progress prose, and all of it lives inside the one work disclosure. Only the
  // answer escapes it. See turn-presentation.ts.
  const presentation = deriveTurnPresentation(items, showThinking)
  // Reasoning is one of the things the work disclosure holds, at its own place
  // in the narrative — never a second disclosure beside the work. Two nested
  // "expand to see" controls made the reader learn a concept the turn does not
  // have; the "Thought" row was the work block's own content rendered as a
  // sibling of it.
  let workItems = presentation.work
  let proseItems = presentation.answerItems
  // A finished turn whose only prose is commentary — no explicit final answer —
  // must still show the one thing Sofia said. Promote that terminal note to the
  // answer instead of leaving the whole execution trace expanded to find it; a
  // failed guess at the answer is not a reason to open the disclosure.
  if (!isLiveGroup && proseItems.length === 0) {
    const lastCommentary = workItems.findLastIndex((entry) => entry.kind === "commentary")
    const promoted = lastCommentary >= 0 ? workItems[lastCommentary] : undefined
    if (promoted?.kind === "commentary") {
      proseItems = [promoted.item]
      workItems = workItems.filter((_, index) => index !== lastCommentary)
    }
  }

  const durationMs = finishedTurnDurationMs(timing)
  // Active: the semantic operation. Finished: how long the turn took.
  const workLabel = turnWorkLabel({
    isLive: isLiveGroup,
    activeLabel,
    durationMs,
    formatDuration: formatToolCallDuration,
  })
  // A finished turn keeps its execution disclosure even when everything it did
  // was talk: "Worked for 1m 30s" is what tells the user how long the turn took,
  // and reading it above the answer is the point.
  const hasWork = workItems.length > 0 || durationMs !== null

  // The turn on screen is the only one still making claims; a settled turn's mix
  // is history.
  if (isLiveGroup) {
    const engine = (items[0]?.message.metadata as { engine?: Record<string, unknown> } | undefined)?.engine ?? {}
    logPresentation({
      turnId: String(engine.turnId ?? "-"),
      commentary: workItems.filter((entry) => entry.kind === "commentary").length,
      // Packets in, phases out: the two numbers side by side are what says
      // whether clustering happened, without reading the DOM.
      reasoning: items.reduce(
        (count, item) => count + item.message.parts.filter((part) => part.type === "reasoning").length,
        0,
      ),
      thoughts: workItems.filter((entry) => entry.kind === "thought").length,
      tools: workItems.reduce(
        (count, entry) =>
          entry.kind === "milestone"
            ? count + entry.parts.length
            : entry.kind === "detail"
              ? count + 1
              : count,
        0,
      ),
      milestones: workItems.filter((entry) => entry.kind === "milestone").length,
      answers: proseItems.length,
    })
  }

  const renderItem = (item: UIMessageWithIndex, groupIndex: number, hideReasoning?: boolean) => {
    const isLastMessage = item.index === messages.length - 1

    return (
      <div key={item.message.id}>
        <MessageComponent
          message={item.message}
          isLastMessage={isLastMessage}
          isStreaming={isLastMessage && isStreaming}
          isLastStep={groupIndex === items.length - 1}
          hideReasoning={hideReasoning}
        />
      </div>
    )
  }

  // The narrative, rendered in the order it happened. Aggregation happened when
  // the presentation was derived, so this only has to place each entry — and a
  // milestone is already one row for a whole run of tool events.
  const renderWorkEntry = (entry: (typeof workItems)[number]) => {
    if (entry.kind === "thought") {
      // One row per reasoning *phase*, not per packet. Behind a detail inside the
      // work block: the narrative is commentary and milestones, and thinking is
      // the reasoning behind them. The phase Sofia is in now stays open, so the
      // reader can see her think; every earlier phase is folded, so nothing
      // inherits a stack of expanded thoughts.
      return (
        <WorkRow key={entry.key} kind="thought">
          <ReasoningBlock
            text={entry.text}
            isStreaming={isLiveGroup && entry.isStreaming}
            defaultOpen={isLiveGroup && entry.isCurrent}
          />
        </WorkRow>
      )
    }
    if (entry.kind === "commentary") {
      return <WorkProse key={entry.key} kind="commentary" message={entry.item.message} />
    }
    if (entry.kind === "milestone") {
      return (
        <WorkRow key={entry.key} kind="milestone">
          <ToolAggregateGroup parts={entry.parts} className="w-full" />
        </WorkRow>
      )
    }
    return (
      <WorkRow key={entry.key} kind="detail">
        <AssistantParts message={entry.item.message} isStreaming={false} hideReasoning />
      </WorkRow>
    )
  }

  return (
      // One outer grouping per assistant turn: the work disclosure plus the answer
      // it produced. Nothing about the turn's interior becomes a transcript sibling.
      <div data-assistant-turn="" className="flex flex-col gap-2 group/message-group">
      {/* The scroll area keeps the same 8px rhythm the parts inside a single
          message use, so a step row is spaced identically whether or not a
          message boundary happens to fall between it and the previous row. */}
      {hasWork ? (
        // One vertical scroll owner: the transcript. The work block is a plain
        // collapsible row (no inner viewport), so the session scroll controller
        // decides whether to follow the tail.
        <div data-live-steps="">
          <TurnWorkBlock
            label={workLabel}
            active={isLiveGroup}
            streaming={isLiveGroup && isStreaming}
            elapsedMs={liveElapsedMs}
            // Open only while it works. A finished turn collapses whatever its
            // answer detection concluded: developer mode changes what expanding
            // shows, not whether a finished turn starts expanded.
            defaultOpen={isLiveGroup}
          >
            {/* The disclosure owns the internal rhythm: whole-narrative rows sit
                closer together than transcript messages do, because they are not
                messages. */}
            <div className="flex flex-col gap-3">
              {workItems.map(renderWorkEntry)}
            </div>
          </TurnWorkBlock>
        </div>
      ) : null}
      {mcpAppParts.map((part) => (
        <Message
          key={`mcp-app-${part.toolCallId}`}
          className="mx-auto flex w-full max-w-[800px] flex-col px-2 empty:hidden md:px-6"
        >
          <McpAppFrame part={part} />
        </Message>
      ))}
      {/* The answer is the one row that escapes the disclosure. */}
      {proseItems.map((item, position) => (
        <div key={`final-answer-${item.message.id}`} data-final-answer="">
          {renderItem(item, position, true)}
        </div>
      ))}
      {/* The turn's result: one summary card for this turn's change set. A turn
          still working has no result yet — showing the card the moment a file is
          touched puts a "what changed" summary inside the work it summarises, and
          it rewrites itself on every edit. It belongs to the settled turn. */}
      {changeSet && !isLiveGroup ? (
        <div className="mx-auto w-full max-w-[800px] px-2 md:px-6">
          <TurnChangeSetCard
            changeSet={changeSet}
            onReviewFile={(path) =>
              usePanelTabStore.getState().openTab(sessionId, {
                id: `changes:${changeSet.id}`,
                type: "changes",
                label: "Changes",
                changeSetId: changeSet.id,
                filePath: path,
              })
            }
            onOpenFile={openArtifactPath}
            onReview={(changeSetId) =>
              usePanelTabStore.getState().openTab(sessionId, {
                id: `changes:${changeSetId}`,
                type: "changes",
                label: "Changes",
                changeSetId,
              })
            }
          />
        </div>
      ) : null}
      {lastTextMessage && !isStreaming && (
        <div className="mx-auto flex w-full max-w-[800px] flex-wrap items-center gap-2 px-2 opacity-0 transition-opacity duration-150 group-hover/message-group:opacity-100 max-lg:opacity-100 pointer-coarse:opacity-100 md:px-8">
          <MessageActions className="flex gap-0">
            <CopyMessageButton messages={renderableItems.map((item) => item.message)} />
            {lastRealItem ? (
              <>
                <MessageAction tooltip="Branch in new chat">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Branch in new chat"
                    onClick={() => onForkAtMessage(lastRealItem.message.id)}
                  >
                    <Split className="rotate-90" />
                  </Button>
                </MessageAction>
                <MessageAction tooltip="Revert">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Revert"
                    onClick={() => onRevertToUserMessage(lastRealItem.message.id)}
                  >
                    <Undo2 />
                  </Button>
                </MessageAction>
              </>
            ) : null}
          </MessageActions>
          <MessageTimestamp message={lastItem.message} />
          {/* <MessageSources messages={items.map((item) => item.message)} /> */}
        </div>
      )}
      </div>
  )
}

interface MessageListProps {
  messages: UIMessage[]
  status: ThreadStatus
  retryStatus?: RetryStatus | null
}

export function shouldShowMessageListLoading(status: ThreadStatus, messageCount: number) {
  return status === "streaming" || (status === "submitted" && messageCount > 0)
}

export function MessageList({ messages, status, retryStatus }: MessageListProps) {
  const { sessionId, showThinking } = useMessageList()
  const isStreaming = status === "streaming" || status === "retrying"
  const showLoading = shouldShowMessageListLoading(status, messages.length)
  const items = React.useMemo(() => groupMessages(messages, status), [messages, status]);
  const error = useSessionErrorMessage();
  const hasSessionErrorMessage = React.useMemo(() => messages.some(isSessionErrorMessage), [messages])
  const activities = useSessionActivities(sessionId)
  // Exactly one live-progress line. An Activity is authoritative ("Running the
  // app tests"); an in-flight tool is the fallback; "Sofia is working…" is
  // reserved for the moments where no operation title exists yet.
  const liveActionLabel = React.useMemo(() => {
    if (!isStreaming) return null
    return liveActivityLabel(activities, getActiveToolLabel(collectLatestAssistantToolParts(messages)))
  }, [isStreaming, activities, messages])
  // Once the live turn has a work block, its header *is* the progress line, so
  // the generic "Sofia is working…" fallback must not render alongside it.
  const lastGroup = items[items.length - 1]
  const liveWorkVisible = isStreaming
    && lastGroup !== undefined
    && isMessageGroup(lastGroup)
    && groupHasWork(lastGroup.messages, showThinking)

  return (
    <div className={cn("flex flex-col gap-2 @container/message-list")}>
      {messages.length === 0 && <TaskSuggestions className="mx-auto w-full max-w-[800px] shrink-0 px-3 pb-3 md:px-5 md:pb-5 grow" />}

      {items.map((item) => {
        if (isMessageGroup(item)) {
          return (
            <MessageGroup
              key={item.messages[0]?.message.id ?? "empty-assistant-group"}
              items={item.messages}
              messages={messages}
              isStreaming={isStreaming}
              activeLabel={liveActionLabel}
            />
          )
        }

        const isLastMessage = item.index === messages.length - 1
        const isLastStep =
          !messages[item.index + 1] || messages[item.index + 1].role !== item.message.role

        return (
          <div key={item.message.id}>
            <MessageComponent
              message={item.message}
              isLastMessage={isLastMessage}
              isStreaming={isLastMessage && isStreaming}
              isLastStep={isLastStep}
            />
            <ArtifactList messages={[item.message]} includeTargetFallbacks={false} />
          </div>
        )
      })}

      {showLoading && !liveWorkVisible ? <LoadingMessage label={liveActionLabel ?? undefined} /> : null}
      {retryStatus ? <RetryMessage status={retryStatus} /> : null}
      {error && !hasSessionErrorMessage ? <ErrorMessage error={error} /> : null}
    </div>
  )
}
