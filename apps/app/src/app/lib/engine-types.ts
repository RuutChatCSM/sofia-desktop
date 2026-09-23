// Local engine types.
//
// These declarations are the subset of the OpenCode v2 generated type surface
// that the app consumes. They were vendored verbatim (type-only, no runtime
// code) from the OpenCode SDK so the app can drop the SDK dependency while
// remaining structurally compatible with the server adapter payloads.
/* eslint-disable */

export type Event = EventModelsDevRefreshed | EventIntegrationUpdated | EventIntegrationConnectionUpdated | EventCatalogUpdated | EventSessionCreated | EventSessionUpdated | EventSessionDeleted | EventMessageUpdated | EventMessageRemoved | EventMessagePartUpdated | EventMessagePartRemoved | EventSessionNextAgentSwitched | EventSessionNextModelSwitched | EventSessionNextMoved | EventSessionNextPrompted | EventSessionNextPromptAdmitted | EventSessionNextContextUpdated | EventSessionNextSynthetic | EventSessionNextShellStarted | EventSessionNextShellEnded | EventSessionNextStepStarted | EventSessionNextStepEnded | EventSessionNextStepFailed | EventSessionNextTextStarted | EventSessionNextTextDelta | EventSessionNextTextEnded | EventSessionNextReasoningStarted | EventSessionNextReasoningDelta | EventSessionNextReasoningEnded | EventSessionNextToolInputStarted | EventSessionNextToolInputDelta | EventSessionNextToolInputEnded | EventSessionNextToolCalled | EventSessionNextToolProgress | EventSessionNextToolSuccess | EventSessionNextToolFailed | EventSessionNextRetried | EventSessionNextCompactionStarted | EventSessionNextCompactionDelta | EventSessionNextCompactionEnded | EventSessionNextRevertStaged | EventSessionNextRevertCleared | EventSessionNextRevertCommitted | EventMessagePartDelta | EventSessionDiff | EventSessionError | EventInstallationUpdated | EventInstallationUpdateAvailable | EventFileEdited | EventReferenceUpdated | EventPermissionV2Asked | EventPermissionV2Replied | EventPluginAdded | EventProjectDirectoriesUpdated | EventFileWatcherUpdated | EventPtyCreated | EventPtyUpdated | EventPtyExited | EventPtyDeleted | EventQuestionV2Asked | EventQuestionV2Replied | EventQuestionV2Rejected | EventTodoUpdated | EventLspUpdated | EventPermissionAsked | EventPermissionReplied | EventTuiPromptAppend2 | EventTuiCommandExecute2 | EventTuiToastShow2 | EventTuiSessionSelect2 | EventMcpToolsChanged | EventMcpBrowserOpenFailed | EventCommandExecuted | EventProjectUpdated | EventSessionStatus | EventSessionIdle | EventQuestionAsked | EventQuestionReplied | EventQuestionRejected | EventSessionCompacted | EventVcsBranchUpdated | EventWorkspaceReady | EventWorkspaceFailed | EventWorkspaceStatus | EventWorktreeReady | EventWorktreeFailed | EventServerConnected | EventGlobalDisposed | EventServerInstanceDisposed;

export type Session = {
    id: string;
    slug: string;
    projectID: string;
    workspaceID?: string;
    directory: string;
    path?: string;
    parentID?: string;
    summary?: {
        additions: number;
        deletions: number;
        files: number;
        diffs?: Array<SnapshotFileDiff>;
    };
    cost?: number;
    tokens?: {
        input: number;
        output: number;
        reasoning: number;
        cache: {
            read: number;
            write: number;
        };
    };
    share?: {
        url: string;
    };
    title: string;
    agent?: string;
    model?: {
        id: string;
        providerID: string;
        variant?: string;
    };
    version: string;
    metadata?: {
        [key: string]: unknown;
    };
    time: {
        created: number;
        updated: number;
        compacting?: number;
        archived?: number;
    };
    permission?: PermissionRuleset;
    revert?: {
        messageID: string;
        partID?: string;
        snapshot?: string;
        diff?: string;
    };
};

export type Message = UserMessage | AssistantMessage;

export type Part = TextPart | SubtaskPart | ReasoningPart | FilePart | ToolPart | StepStartPart | StepFinishPart | SnapshotPart | PatchPart | AgentPart | RetryPart | CompactionPart;

export type Todo = {
    /**
     * Brief description of the task
     */
    content: string;
    /**
     * Current status of the task: pending, in_progress, completed, cancelled
     */
    status: string;
    /**
     * Priority level of the task: high, medium, low
     */
    priority: string;
};

export type SessionStatus = {
    type: "idle";
} | {
    type: "retry";
    attempt: number;
    message: string;
    action?: {
        reason: string;
        provider: string;
        title: string;
        message: string;
        label: string;
        link?: string;
    };
    next: number;
} | {
    type: "busy";
};

export type ProviderListResponse = ProviderListResponses[keyof ProviderListResponses];

export type ProviderConfig = {
    api?: string;
    name?: string;
    env?: Array<string>;
    id?: string;
    npm?: string;
    whitelist?: Array<string>;
    blacklist?: Array<string>;
    options?: {
        apiKey?: string;
        baseURL?: string;
        enterpriseUrl?: string;
        setCacheKey?: boolean;
        /**
         * Timeout in milliseconds for full requests to this provider. Set to false to disable timeout.
         */
        timeout?: number | false;
        /**
         * Timeout in milliseconds to wait for response headers. Provider integrations may set defaults. Set to false to disable timeout.
         */
        headerTimeout?: number | false;
        chunkTimeout?: number;
        [key: string]: unknown | string | boolean | number | false | number | false | number | undefined;
    };
    models?: {
        [key: string]: {
            id?: string;
            name?: string;
            family?: string;
            release_date?: string;
            attachment?: boolean;
            reasoning?: boolean;
            temperature?: boolean;
            tool_call?: boolean;
            interleaved?: boolean | "reasoning" | "reasoning_content" | "reasoning_text" | string | {
                field: "reasoning" | "reasoning_content" | "reasoning_text" | string;
            };
            cost?: {
                input: number;
                output: number;
                cache_read?: number;
                cache_write?: number;
                context_over_200k?: {
                    input: number;
                    output: number;
                    cache_read?: number;
                    cache_write?: number;
                };
            };
            limit?: {
                context: number;
                input?: number;
                output: number;
            };
            modalities?: {
                input?: Array<"text" | "audio" | "image" | "video" | "pdf">;
                output?: Array<"text" | "audio" | "image" | "video" | "pdf">;
            };
            experimental?: boolean;
            status?: "alpha" | "beta" | "deprecated" | "active";
            provider?: {
                npm?: string;
                api?: string;
            };
            options?: {
                [key: string]: unknown;
            };
            headers?: {
                [key: string]: string;
            };
            /**
             * Variant-specific configuration
             */
            variants?: {
                [key: string]: {
                    disabled?: boolean;
                    [key: string]: unknown | boolean | undefined;
                };
            };
        };
    };
};

export type ProviderAuthAuthorization = {
    url: string;
    method: "auto" | "code";
    instructions: string;
};

export type ProviderAuthResponse = ProviderAuthResponses[keyof ProviderAuthResponses];

export type Agent = {
    name: string;
    description?: string;
    mode: "subagent" | "primary" | "all";
    native?: boolean;
    hidden?: boolean;
    topP?: number;
    temperature?: number;
    color?: string;
    permission: PermissionRuleset;
    model?: {
        modelID: string;
        providerID: string;
    };
    variant?: string;
    prompt?: string;
    options: {
        [key: string]: unknown;
    };
    steps?: number;
};

export type AgentPartInput = {
    id?: string;
    type: "agent";
    name: string;
    source?: {
        value: string;
        start: number;
        end: number;
    };
};

export type FilePartInput = {
    id?: string;
    type: "file";
    mime: string;
    filename?: string;
    url: string;
    source?: FilePartSource;
};

export type SubtaskPartInput = {
    id?: string;
    type: "subtask";
    prompt: string;
    description: string;
    agent: string;
    model?: {
        providerID: string;
        modelID: string;
    };
    command?: string;
};

export type TextPartInput = {
    id?: string;
    type: "text";
    text: string;
    synthetic?: boolean;
    ignored?: boolean;
    time?: {
        start: number;
        end?: number;
    };
    metadata?: {
        [key: string]: unknown;
    };
};

export type FilePart = {
    id: string;
    sessionID: string;
    messageID: string;
    type: "file";
    mime: string;
    filename?: string;
    url: string;
    source?: FilePartSource;
};

export type ToolPart = {
    id: string;
    sessionID: string;
    messageID: string;
    type: "tool";
    callID: string;
    tool: string;
    state: ToolState;
    metadata?: {
        [key: string]: unknown;
    };
};

export type QuestionInfo = {
    /**
     * Complete question
     */
    question: string;
    /**
     * Very short label (max 30 chars)
     */
    header: string;
    /**
     * Available choices
     */
    options: Array<QuestionOption>;
    multiple?: boolean;
    custom?: boolean;
};

export type QuestionRequest = {
    id: string;
    sessionID: string;
    /**
     * Questions to ask
     */
    questions: Array<QuestionInfo>;
    tool?: QuestionTool;
};

export type PermissionRequest = {
    id: string;
    sessionID: string;
    permission: string;
    patterns: Array<string>;
    metadata: {
        [key: string]: unknown;
    };
    always: Array<string>;
    tool?: {
        messageID: string;
        callID: string;
    };
};

export type PermissionV2Request = {
    id: string;
    sessionID: string;
    action: string;
    resources: Array<string>;
    save?: Array<string>;
    metadata?: {
        [key: string]: unknown;
    };
    source?: PermissionV2Source;
};

export type LspStatus = {
    id: string;
    name: string;
    root: string;
    status: "connected" | "error";
};

export type Project = {
    id: string;
    worktree: string;
    vcs?: ProjectVcs;
    name?: string;
    icon?: ProjectIcon;
    commands?: ProjectCommands;
    time: ProjectTime;
    sandboxes: Array<string>;
};

export type VcsInfo = {
    branch?: string;
    default_branch?: string;
};

export type Config = {
    $schema?: string;
    shell?: string;
    logLevel?: LogLevel;
    server?: ServerConfig;
    command?: {
        [key: string]: {
            template: string;
            description?: string;
            agent?: string;
            model?: string;
            variant?: string;
            subtask?: boolean;
        };
    };
    skills?: {
        paths?: Array<string>;
        urls?: Array<string>;
    };
    references?: {
        [key: string]: string | ConfigV2ReferenceGit | ConfigV2ReferenceLocal;
    };
    reference?: {
        [key: string]: string | ConfigV2ReferenceGit | ConfigV2ReferenceLocal;
    };
    watcher?: {
        ignore?: Array<string>;
    };
    snapshot?: boolean;
    plugin?: Array<string | [
        string,
        {
            [key: string]: unknown;
        }
    ]>;
    share?: "manual" | "auto" | "disabled";
    autoshare?: boolean;
    /**
     * Automatically update to the latest version. Set to true to auto-update, false to disable, or 'notify' to show update notifications
     */
    autoupdate?: boolean | "notify";
    disabled_providers?: Array<string>;
    enabled_providers?: Array<string>;
    model?: string;
    small_model?: string;
    default_agent?: string;
    subagent_depth?: number;
    username?: string;
    mode?: {
        build?: AgentConfig;
        plan?: AgentConfig;
        [key: string]: AgentConfig | undefined;
    };
    agent?: {
        plan?: AgentConfig;
        build?: AgentConfig;
        general?: AgentConfig;
        explore?: AgentConfig;
        title?: AgentConfig;
        summary?: AgentConfig;
        compaction?: AgentConfig;
        [key: string]: AgentConfig | undefined;
    };
    provider?: {
        [key: string]: ProviderConfig;
    };
    mcp?: {
        [key: string]: McpLocalConfig | McpRemoteConfig | {
            enabled: boolean;
        };
    };
    /**
     * Enable or configure formatters. Omit or set to false to disable, true to enable built-ins, or an object to enable built-ins with overrides.
     */
    formatter?: boolean | {
        [key: string]: {
            disabled?: boolean;
            command?: Array<string>;
            environment?: {
                [key: string]: string;
            };
            extensions?: Array<string>;
        };
    };
    /**
     * Enable or configure LSP servers. Omit or set to false to disable, true to enable built-ins, or an object to enable built-ins with overrides.
     */
    lsp?: boolean | {
        [key: string]: {
            disabled: true;
        } | {
            command: Array<string>;
            extensions?: Array<string>;
            disabled?: boolean;
            env?: {
                [key: string]: string;
            };
            initialization?: {
                [key: string]: unknown;
            };
        };
    };
    instructions?: Array<string>;
    layout?: LayoutConfig;
    permission?: PermissionConfig;
    tools?: {
        [key: string]: boolean;
    };
    attachment?: AttachmentConfig;
    enterprise?: {
        url?: string;
    };
    tool_output?: {
        max_lines?: number;
        max_bytes?: number;
    };
    compaction?: {
        auto?: boolean;
        prune?: boolean;
        tail_turns?: number;
        preserve_recent_tokens?: number;
        reserved?: number;
    };
    experimental?: {
        disable_paste_summary?: boolean;
        batch_tool?: boolean;
        openTelemetry?: boolean;
        primary_tools?: Array<string>;
        continue_loop_on_deny?: boolean;
        mcp_timeout?: number;
        policies?: Array<ConfigV2ExperimentalPolicy>;
    };
};

export type GlobalHealthResponse = GlobalHealthResponses[keyof GlobalHealthResponses];

export type AgentConfig = {
    model?: string;
    variant?: string;
    temperature?: number;
    top_p?: number;
    prompt?: string;
    tools?: {
        [key: string]: boolean;
    };
    disable?: boolean;
    description?: string;
    mode?: "subagent" | "primary" | "all";
    hidden?: boolean;
    options?: {
        [key: string]: unknown;
    };
    /**
     * Hex color code (e.g., #FF5733) or theme color (e.g., primary)
     */
    color?: string | "primary" | "secondary" | "accent" | "success" | "warning" | "error" | "info";
    steps?: number;
    maxSteps?: number;
    permission?: PermissionConfig;
    [key: string]: unknown | string | number | {
        [key: string]: boolean;
    } | boolean | "subagent" | "primary" | "all" | {
        [key: string]: unknown;
    } | string | "primary" | "secondary" | "accent" | "success" | "warning" | "error" | "info" | number | PermissionConfig | undefined;
};

export type AgentPart = {
    id: string;
    sessionID: string;
    messageID: string;
    type: "agent";
    name: string;
    source?: {
        value: string;
        start: number;
        end: number;
    };
};

export type ApiError = {
    name: "APIError";
    data: {
        message: string;
        statusCode?: number;
        isRetryable: boolean;
        responseHeaders?: {
            [key: string]: string;
        };
        responseBody?: string;
        metadata?: {
            [key: string]: string;
        };
    };
};

export type AssistantMessage = {
    id: string;
    sessionID: string;
    role: "assistant";
    time: {
        created: number;
        completed?: number;
    };
    error?: ProviderAuthError | UnknownError | MessageOutputLengthError | MessageAbortedError | StructuredOutputError | ContextOverflowError | ContentFilterError | ApiError;
    parentID: string;
    modelID: string;
    providerID: string;
    mode: string;
    agent: string;
    path: {
        cwd: string;
        root: string;
    };
    summary?: boolean;
    cost: number;
    tokens: {
        total?: number;
        input: number;
        output: number;
        reasoning: number;
        cache: {
            read: number;
            write: number;
        };
    };
    structured?: unknown;
    variant?: string;
    finish?: string;
};

export type AttachmentConfig = {
    image?: ImageAttachmentConfig;
};

export type Command = {
    name: string;
    description?: string;
    agent?: string;
    model?: string;
    source?: "command" | "mcp" | "skill";
    template: string;
    subtask?: boolean;
    hints: Array<string>;
};

export type CompactionPart = {
    id: string;
    sessionID: string;
    messageID: string;
    type: "compaction";
    auto: boolean;
    overflow?: boolean;
    tail_start_id?: string;
};

export type ConfigV2ExperimentalPolicy = {
    action: "provider.use";
    effect: PolicyEffect;
    resource: string;
};

export type ConfigV2ReferenceGit = {
    repository: string;
    branch?: string;
    description?: string;
    hidden?: boolean;
};

export type ConfigV2ReferenceLocal = {
    path: string;
    description?: string;
    hidden?: boolean;
};

export type ContentFilterError = {
    name: "ContentFilterError";
    data: {
        message: string;
    };
};

export type ContextOverflowError = {
    name: "ContextOverflowError";
    data: {
        message: string;
        responseBody?: string;
    };
};

export type EventCatalogUpdated = {
    id: string;
    type: "catalog.updated";
    properties: {
        [key: string]: unknown;
    };
};

export type EventCommandExecuted = {
    id: string;
    type: "command.executed";
    properties: {
        name: string;
        sessionID: string;
        arguments: string;
        messageID: string;
    };
};

export type EventFileEdited = {
    id: string;
    type: "file.edited";
    properties: {
        file: string;
    };
};

export type EventFileWatcherUpdated = {
    id: string;
    type: "file.watcher.updated";
    properties: {
        file: string;
        event: "add" | "change" | "unlink";
    };
};

export type EventGlobalDisposed = {
    id: string;
    type: "global.disposed";
    properties: {
        [key: string]: unknown;
    };
};

export type EventInstallationUpdateAvailable = {
    id: string;
    type: "installation.update-available";
    properties: {
        version: string;
    };
};

export type EventInstallationUpdated = {
    id: string;
    type: "installation.updated";
    properties: {
        version: string;
    };
};

export type EventIntegrationConnectionUpdated = {
    id: string;
    type: "integration.connection.updated";
    properties: {
        integrationID: string;
    };
};

export type EventIntegrationUpdated = {
    id: string;
    type: "integration.updated";
    properties: {
        [key: string]: unknown;
    };
};

export type EventLspUpdated = {
    id: string;
    type: "lsp.updated";
    properties: {
        [key: string]: unknown;
    };
};

export type EventMcpBrowserOpenFailed = {
    id: string;
    type: "mcp.browser.open.failed";
    properties: {
        mcpName: string;
        url: string;
    };
};

export type EventMcpToolsChanged = {
    id: string;
    type: "mcp.tools.changed";
    properties: {
        server: string;
    };
};

export type EventMessagePartDelta = {
    id: string;
    type: "message.part.delta";
    properties: {
        sessionID: string;
        messageID: string;
        partID: string;
        field: string;
        delta: string;
    };
};

export type EventMessagePartRemoved = {
    id: string;
    type: "message.part.removed";
    properties: {
        sessionID: string;
        messageID: string;
        partID: string;
    };
};

export type EventMessagePartUpdated = {
    id: string;
    type: "message.part.updated";
    properties: {
        sessionID: string;
        part: Part;
        time: number;
    };
};

export type EventMessageRemoved = {
    id: string;
    type: "message.removed";
    properties: {
        sessionID: string;
        messageID: string;
    };
};

export type EventMessageUpdated = {
    id: string;
    type: "message.updated";
    properties: {
        sessionID: string;
        info: Message;
    };
};

export type EventModelsDevRefreshed = {
    id: string;
    type: "models-dev.refreshed";
    properties: {
        [key: string]: unknown;
    };
};

export type EventPermissionAsked = {
    id: string;
    type: "permission.asked";
    properties: {
        id: string;
        sessionID: string;
        permission: string;
        patterns: Array<string>;
        metadata: {
            [key: string]: unknown;
        };
        always: Array<string>;
        tool?: {
            messageID: string;
            callID: string;
        };
    };
};

export type EventPermissionReplied = {
    id: string;
    type: "permission.replied";
    properties: {
        sessionID: string;
        requestID: string;
        reply: "once" | "always" | "reject";
    };
};

export type EventPermissionV2Asked = {
    id: string;
    type: "permission.v2.asked";
    properties: {
        id: string;
        sessionID: string;
        action: string;
        resources: Array<string>;
        save?: Array<string>;
        metadata?: {
            [key: string]: unknown;
        };
        source?: PermissionV2Source;
    };
};

export type EventPermissionV2Replied = {
    id: string;
    type: "permission.v2.replied";
    properties: {
        sessionID: string;
        requestID: string;
        reply: PermissionV2Reply;
    };
};

export type EventPluginAdded = {
    id: string;
    type: "plugin.added";
    properties: {
        id: string;
    };
};

export type EventProjectDirectoriesUpdated = {
    id: string;
    type: "project.directories.updated";
    properties: {
        projectID: string;
    };
};

export type EventProjectUpdated = {
    id: string;
    type: "project.updated";
    properties: {
        id: string;
        worktree: string;
        vcs?: ProjectVcs;
        name?: string;
        icon?: ProjectIcon;
        commands?: ProjectCommands;
        time: ProjectTime;
        sandboxes: Array<string>;
    };
};

export type EventPtyCreated = {
    id: string;
    type: "pty.created";
    properties: {
        info: Pty;
    };
};

export type EventPtyDeleted = {
    id: string;
    type: "pty.deleted";
    properties: {
        id: string;
    };
};

export type EventPtyExited = {
    id: string;
    type: "pty.exited";
    properties: {
        id: string;
        exitCode: number;
    };
};

export type EventPtyUpdated = {
    id: string;
    type: "pty.updated";
    properties: {
        info: Pty;
    };
};

export type EventQuestionAsked = {
    id: string;
    type: "question.asked";
    properties: {
        id: string;
        sessionID: string;
        /**
         * Questions to ask
         */
        questions: Array<QuestionInfo>;
        tool?: QuestionTool;
    };
};

export type EventQuestionRejected = {
    id: string;
    type: "question.rejected";
    properties: {
        sessionID: string;
        requestID: string;
    };
};

export type EventQuestionReplied = {
    id: string;
    type: "question.replied";
    properties: {
        sessionID: string;
        requestID: string;
        answers: Array<QuestionAnswer>;
    };
};

export type EventQuestionV2Asked = {
    id: string;
    type: "question.v2.asked";
    properties: {
        id: string;
        sessionID: string;
        /**
         * Questions to ask
         */
        questions: Array<QuestionV2Info>;
        tool?: QuestionV2Tool;
    };
};

export type EventQuestionV2Rejected = {
    id: string;
    type: "question.v2.rejected";
    properties: {
        sessionID: string;
        requestID: string;
    };
};

export type EventQuestionV2Replied = {
    id: string;
    type: "question.v2.replied";
    properties: {
        sessionID: string;
        requestID: string;
        answers: Array<QuestionV2Answer>;
    };
};

export type EventReferenceUpdated = {
    id: string;
    type: "reference.updated";
    properties: {
        [key: string]: unknown;
    };
};

export type EventServerConnected = {
    id: string;
    type: "server.connected";
    properties: {
        [key: string]: unknown;
    };
};

export type EventServerInstanceDisposed = {
    id: string;
    type: "server.instance.disposed";
    properties: {
        directory: string;
    };
};

export type EventSessionCompacted = {
    id: string;
    type: "session.compacted";
    properties: {
        sessionID: string;
    };
};

export type EventSessionCreated = {
    id: string;
    type: "session.created";
    properties: {
        sessionID: string;
        info: Session;
    };
};

export type EventSessionDeleted = {
    id: string;
    type: "session.deleted";
    properties: {
        sessionID: string;
        info: Session;
    };
};

export type EventSessionDiff = {
    id: string;
    type: "session.diff";
    properties: {
        sessionID: string;
        diff: Array<SnapshotFileDiff>;
    };
};

export type EventSessionError = {
    id: string;
    type: "session.error";
    properties: {
        sessionID?: string;
        error?: ProviderAuthError | UnknownError | MessageOutputLengthError | MessageAbortedError | StructuredOutputError | ContextOverflowError | ContentFilterError | ApiError;
    };
};

export type EventSessionIdle = {
    id: string;
    type: "session.idle";
    properties: {
        sessionID: string;
    };
};

export type EventSessionNextAgentSwitched = {
    id: string;
    type: "session.next.agent.switched";
    properties: {
        timestamp: number;
        sessionID: string;
        messageID: string;
        agent: string;
    };
};

export type EventSessionNextCompactionDelta = {
    id: string;
    type: "session.next.compaction.delta";
    properties: {
        timestamp: number;
        sessionID: string;
        messageID: string;
        text: string;
    };
};

export type EventSessionNextCompactionEnded = {
    id: string;
    type: "session.next.compaction.ended";
    properties: {
        timestamp: number;
        sessionID: string;
        messageID: string;
        reason: "auto" | "manual";
        text: string;
        recent: string;
    };
};

export type EventSessionNextCompactionStarted = {
    id: string;
    type: "session.next.compaction.started";
    properties: {
        timestamp: number;
        sessionID: string;
        messageID: string;
        reason: "auto" | "manual";
    };
};

export type EventSessionNextContextUpdated = {
    id: string;
    type: "session.next.context.updated";
    properties: {
        timestamp: number;
        sessionID: string;
        messageID: string;
        text: string;
    };
};

export type EventSessionNextModelSwitched = {
    id: string;
    type: "session.next.model.switched";
    properties: {
        timestamp: number;
        sessionID: string;
        messageID: string;
        model: ModelRef;
    };
};

export type EventSessionNextMoved = {
    id: string;
    type: "session.next.moved";
    properties: {
        timestamp: number;
        sessionID: string;
        location: LocationRef;
        subdirectory?: string;
    };
};

export type EventSessionNextPromptAdmitted = {
    id: string;
    type: "session.next.prompt.admitted";
    properties: {
        timestamp: number;
        sessionID: string;
        messageID: string;
        prompt: Prompt;
        delivery: "steer" | "queue";
    };
};

export type EventSessionNextPrompted = {
    id: string;
    type: "session.next.prompted";
    properties: {
        timestamp: number;
        sessionID: string;
        messageID: string;
        prompt: Prompt;
        delivery: "steer" | "queue";
    };
};

export type EventSessionNextReasoningDelta = {
    id: string;
    type: "session.next.reasoning.delta";
    properties: {
        timestamp: number;
        sessionID: string;
        assistantMessageID: string;
        reasoningID: string;
        delta: string;
    };
};

export type EventSessionNextReasoningEnded = {
    id: string;
    type: "session.next.reasoning.ended";
    properties: {
        timestamp: number;
        sessionID: string;
        assistantMessageID: string;
        reasoningID: string;
        text: string;
        providerMetadata?: LlmProviderMetadata;
    };
};

export type EventSessionNextReasoningStarted = {
    id: string;
    type: "session.next.reasoning.started";
    properties: {
        timestamp: number;
        sessionID: string;
        assistantMessageID: string;
        reasoningID: string;
        providerMetadata?: LlmProviderMetadata;
    };
};

export type EventSessionNextRetried = {
    id: string;
    type: "session.next.retried";
    properties: {
        timestamp: number;
        sessionID: string;
        attempt: number;
        error: SessionNextRetryError;
    };
};

export type EventSessionNextRevertCleared = {
    id: string;
    type: "session.next.revert.cleared";
    properties: {
        timestamp: number;
        sessionID: string;
    };
};

export type EventSessionNextRevertCommitted = {
    id: string;
    type: "session.next.revert.committed";
    properties: {
        timestamp: number;
        sessionID: string;
        messageID: string;
    };
};

export type EventSessionNextRevertStaged = {
    id: string;
    type: "session.next.revert.staged";
    properties: {
        timestamp: number;
        sessionID: string;
        revert: RevertState;
    };
};

export type EventSessionNextShellEnded = {
    id: string;
    type: "session.next.shell.ended";
    properties: {
        timestamp: number;
        sessionID: string;
        callID: string;
        output: string;
    };
};

export type EventSessionNextShellStarted = {
    id: string;
    type: "session.next.shell.started";
    properties: {
        timestamp: number;
        sessionID: string;
        messageID: string;
        callID: string;
        command: string;
    };
};

export type EventSessionNextStepEnded = {
    id: string;
    type: "session.next.step.ended";
    properties: {
        timestamp: number;
        sessionID: string;
        assistantMessageID: string;
        finish: string;
        cost: number;
        tokens: {
            input: number;
            output: number;
            reasoning: number;
            cache: {
                read: number;
                write: number;
            };
        };
        snapshot?: string;
        files?: Array<string>;
    };
};

export type EventSessionNextStepFailed = {
    id: string;
    type: "session.next.step.failed";
    properties: {
        timestamp: number;
        sessionID: string;
        assistantMessageID: string;
        error: SessionErrorUnknown;
    };
};

export type EventSessionNextStepStarted = {
    id: string;
    type: "session.next.step.started";
    properties: {
        timestamp: number;
        sessionID: string;
        assistantMessageID: string;
        agent: string;
        model: ModelRef;
        snapshot?: string;
    };
};

export type EventSessionNextSynthetic = {
    id: string;
    type: "session.next.synthetic";
    properties: {
        timestamp: number;
        sessionID: string;
        messageID: string;
        text: string;
    };
};

export type EventSessionNextTextDelta = {
    id: string;
    type: "session.next.text.delta";
    properties: {
        timestamp: number;
        sessionID: string;
        assistantMessageID: string;
        textID: string;
        delta: string;
    };
};

export type EventSessionNextTextEnded = {
    id: string;
    type: "session.next.text.ended";
    properties: {
        timestamp: number;
        sessionID: string;
        assistantMessageID: string;
        textID: string;
        text: string;
    };
};

export type EventSessionNextTextStarted = {
    id: string;
    type: "session.next.text.started";
    properties: {
        timestamp: number;
        sessionID: string;
        assistantMessageID: string;
        textID: string;
    };
};

export type EventSessionNextToolCalled = {
    id: string;
    type: "session.next.tool.called";
    properties: {
        timestamp: number;
        sessionID: string;
        assistantMessageID: string;
        callID: string;
        tool: string;
        input: {
            [key: string]: unknown;
        };
        provider: {
            executed: boolean;
            metadata?: LlmProviderMetadata;
        };
    };
};

export type EventSessionNextToolFailed = {
    id: string;
    type: "session.next.tool.failed";
    properties: {
        timestamp: number;
        sessionID: string;
        assistantMessageID: string;
        callID: string;
        error: SessionErrorUnknown;
        result?: unknown;
        provider: {
            executed: boolean;
            metadata?: LlmProviderMetadata;
        };
    };
};

export type EventSessionNextToolInputDelta = {
    id: string;
    type: "session.next.tool.input.delta";
    properties: {
        timestamp: number;
        sessionID: string;
        assistantMessageID: string;
        callID: string;
        delta: string;
    };
};

export type EventSessionNextToolInputEnded = {
    id: string;
    type: "session.next.tool.input.ended";
    properties: {
        timestamp: number;
        sessionID: string;
        assistantMessageID: string;
        callID: string;
        text: string;
    };
};

export type EventSessionNextToolInputStarted = {
    id: string;
    type: "session.next.tool.input.started";
    properties: {
        timestamp: number;
        sessionID: string;
        assistantMessageID: string;
        callID: string;
        name: string;
    };
};

export type EventSessionNextToolProgress = {
    id: string;
    type: "session.next.tool.progress";
    properties: {
        timestamp: number;
        sessionID: string;
        assistantMessageID: string;
        callID: string;
        structured: {
            [key: string]: unknown;
        };
        content: Array<LlmToolContent>;
    };
};

export type EventSessionNextToolSuccess = {
    id: string;
    type: "session.next.tool.success";
    properties: {
        timestamp: number;
        sessionID: string;
        assistantMessageID: string;
        callID: string;
        structured: {
            [key: string]: unknown;
        };
        content: Array<LlmToolContent>;
        outputPaths?: Array<string>;
        result?: unknown;
        provider: {
            executed: boolean;
            metadata?: LlmProviderMetadata;
        };
    };
};

export type EventSessionStatus = {
    id: string;
    type: "session.status";
    properties: {
        sessionID: string;
        status: SessionStatus;
    };
};

export type EventSessionUpdated = {
    id: string;
    type: "session.updated";
    properties: {
        sessionID: string;
        info: Session;
    };
};

export type EventTodoUpdated = {
    id: string;
    type: "todo.updated";
    properties: {
        sessionID: string;
        todos: Array<Todo>;
    };
};

export type EventTuiCommandExecute2 = {
    id: string;
    type: "tui.command.execute";
    properties: {
        command: "session.list" | "session.new" | "session.share" | "session.interrupt" | "session.compact" | "session.page.up" | "session.page.down" | "session.line.up" | "session.line.down" | "session.half.page.up" | "session.half.page.down" | "session.first" | "session.last" | "prompt.clear" | "prompt.submit" | "agent.cycle" | string;
    };
};

export type EventTuiPromptAppend2 = {
    id: string;
    type: "tui.prompt.append";
    properties: {
        text: string;
    };
};

export type EventTuiSessionSelect2 = {
    id: string;
    type: "tui.session.select";
    properties: {
        /**
         * Session ID to navigate to
         */
        sessionID: string;
    };
};

export type EventTuiToastShow2 = {
    id: string;
    type: "tui.toast.show";
    properties: {
        title?: string;
        message: string;
        variant: "info" | "success" | "warning" | "error";
        duration?: number;
    };
};

export type EventVcsBranchUpdated = {
    id: string;
    type: "vcs.branch.updated";
    properties: {
        branch?: string;
    };
};

export type EventWorkspaceFailed = {
    id: string;
    type: "workspace.failed";
    properties: {
        message: string;
    };
};

export type EventWorkspaceReady = {
    id: string;
    type: "workspace.ready";
    properties: {
        name: string;
    };
};

export type EventWorkspaceStatus = {
    id: string;
    type: "workspace.status";
    properties: {
        workspaceID: string;
        status: "connected" | "connecting" | "disconnected" | "error";
    };
};

export type EventWorktreeFailed = {
    id: string;
    type: "worktree.failed";
    properties: {
        message: string;
    };
};

export type EventWorktreeReady = {
    id: string;
    type: "worktree.ready";
    properties: {
        name: string;
        branch?: string;
    };
};

export type FileDiff = {
    path: string;
    status: "added" | "modified" | "deleted";
    additions: number;
    deletions: number;
    patch: string;
};

export type FilePartSource = FileSource | SymbolSource | ResourceSource;

export type FilePartSourceText = {
    value: string;
    start: number;
    end: number;
};

export type FileSource = {
    text: FilePartSourceText;
    type: "file";
    path: string;
};

export type GlobalHealthResponses = {
    /**
     * Health information
     */
    200: {
        healthy: true;
        version: string;
    };
};

export type ImageAttachmentConfig = {
    auto_resize?: boolean;
    max_width?: number;
    max_height?: number;
    max_base64_bytes?: number;
};

export type JsonSchema = {
    [key: string]: unknown;
};

export type LayoutConfig = "auto" | "stretch";

export type LlmProviderMetadata = {
    [key: string]: {
        [key: string]: unknown;
    };
};

export type LlmToolContent = ToolTextContent | ToolFileContent;

export type LocationRef = {
    directory: string;
    workspaceID?: string;
};

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export type McpLocalConfig = {
    /**
     * Type of MCP server connection
     */
    type: "local";
    /**
     * Command and arguments to run the MCP server
     */
    command: Array<string>;
    cwd?: string;
    environment?: {
        [key: string]: string;
    };
    enabled?: boolean;
    timeout?: number;
};

export type McpOAuthConfig = {
    clientId?: string;
    clientSecret?: string;
    scope?: string;
    callbackPort?: number;
    redirectUri?: string;
};

export type McpRemoteConfig = {
    /**
     * Type of MCP server connection
     */
    type: "remote";
    /**
     * URL of the remote MCP server
     */
    url: string;
    enabled?: boolean;
    headers?: {
        [key: string]: string;
    };
    /**
     * OAuth authentication configuration for the MCP server. Set to false to disable OAuth auto-detection.
     */
    oauth?: McpOAuthConfig | false;
    timeout?: number;
};

export type MessageAbortedError = {
    name: "MessageAbortedError";
    data: {
        message: string;
    };
};

export type MessageOutputLengthError = {
    name: "MessageOutputLengthError";
    data: {
        [key: string]: unknown;
    };
};

export type Model = {
    id: string;
    providerID: string;
    api: {
        id: string;
        url: string;
        npm: string;
    };
    name: string;
    family?: string;
    capabilities: {
        temperature: boolean;
        reasoning: boolean;
        attachment: boolean;
        toolcall: boolean;
        input: {
            text: boolean;
            audio: boolean;
            image: boolean;
            video: boolean;
            pdf: boolean;
        };
        output: {
            text: boolean;
            audio: boolean;
            image: boolean;
            video: boolean;
            pdf: boolean;
        };
        interleaved: boolean | {
            field: "reasoning" | "reasoning_content" | "reasoning_text" | string;
        };
    };
    cost: {
        input: number;
        output: number;
        cache: {
            read: number;
            write: number;
        };
        tiers?: Array<{
            input: number;
            output: number;
            cache: {
                read: number;
                write: number;
            };
            tier: {
                type: "context";
                size: number;
            };
        }>;
        experimentalOver200K?: {
            input: number;
            output: number;
            cache: {
                read: number;
                write: number;
            };
        };
    };
    limit: {
        context: number;
        input?: number;
        output: number;
    };
    status: "alpha" | "beta" | "deprecated" | "active";
    options: {
        [key: string]: unknown;
    };
    headers: {
        [key: string]: string;
    };
    release_date: string;
    variants?: {
        [key: string]: {
            [key: string]: unknown;
        };
    };
};

export type ModelRef = {
    id: string;
    providerID: string;
    variant?: string;
};

export type OAuth = {
    type: "oauth";
    refresh: string;
    access: string;
    expires: number;
    accountId?: string;
    enterpriseUrl?: string;
};

export type OutputFormat = OutputFormatText | OutputFormatJsonSchema;

export type OutputFormatJsonSchema = {
    type: "json_schema";
    schema: JsonSchema;
    retryCount?: number;
};

export type OutputFormatText = {
    type: "text";
};

export type PatchPart = {
    id: string;
    sessionID: string;
    messageID: string;
    type: "patch";
    hash: string;
    files: Array<string>;
};

export type PermissionAction = "allow" | "deny" | "ask";

export type PermissionActionConfig = "ask" | "allow" | "deny";

export type PermissionConfig = PermissionActionConfig | {
    read?: PermissionRuleConfig;
    edit?: PermissionRuleConfig;
    glob?: PermissionRuleConfig;
    grep?: PermissionRuleConfig;
    list?: PermissionRuleConfig;
    bash?: PermissionRuleConfig;
    task?: PermissionRuleConfig;
    external_directory?: PermissionRuleConfig;
    todowrite?: PermissionActionConfig;
    question?: PermissionActionConfig;
    webfetch?: PermissionActionConfig;
    websearch?: PermissionActionConfig;
    lsp?: PermissionRuleConfig;
    doom_loop?: PermissionActionConfig;
    skill?: PermissionRuleConfig;
    [key: string]: PermissionRuleConfig | PermissionActionConfig | undefined;
};

export type PermissionObjectConfig = {
    [key: string]: PermissionActionConfig;
};

export type PermissionRule = {
    permission: string;
    pattern: string;
    action: PermissionAction;
};

export type PermissionRuleConfig = PermissionActionConfig | PermissionObjectConfig;

export type PermissionRuleset = Array<PermissionRule>;

export type PermissionV2Reply = "once" | "always" | "reject";

export type PermissionV2Source = {
    type: "tool";
    messageID: string;
    callID: string;
};

export type PolicyEffect = "allow" | "deny";

export type ProjectCommands = {
    /**
     * Startup script to run when creating a new workspace (worktree)
     */
    start?: string;
};

export type ProjectIcon = {
    url?: string;
    override?: string;
    color?: string;
};

export type ProjectTime = {
    created: number;
    updated: number;
    initialized?: number;
};

export type ProjectVcs = "git";

export type Prompt = {
    text: string;
    files?: Array<PromptFileAttachment>;
    agents?: Array<PromptAgentAttachment>;
};

export type PromptAgentAttachment = {
    name: string;
    source?: PromptSource;
};

export type PromptFileAttachment = {
    uri: string;
    mime: string;
    name?: string;
    description?: string;
    source?: PromptSource;
};

export type PromptSource = {
    start: number;
    end: number;
    text: string;
};

export type Provider = {
    id: string;
    name: string;
    source: "env" | "config" | "custom" | "api";
    env: Array<string>;
    key?: string;
    options: {
        [key: string]: unknown;
    };
    models: {
        [key: string]: Model;
    };
};

export type ProviderAuthError = {
    name: "ProviderAuthError";
    data: {
        providerID: string;
        message: string;
    };
};

export type ProviderAuthMethod = {
    type: "oauth" | "api";
    label: string;
    prompts?: Array<{
        type: "text";
        key: string;
        message: string;
        placeholder?: string;
        when?: {
            key: string;
            op: "eq" | "neq";
            value: string;
        };
    } | {
        type: "select";
        key: string;
        message: string;
        options: Array<{
            label: string;
            value: string;
            hint?: string;
        }>;
        when?: {
            key: string;
            op: "eq" | "neq";
            value: string;
        };
    }>;
};

export type ProviderAuthResponses = {
    /**
     * Provider auth methods
     */
    200: {
        [key: string]: Array<ProviderAuthMethod>;
    };
};

export type ProviderListResponses = {
    /**
     * List of providers
     */
    200: {
        all: Array<Provider>;
        default: {
            [key: string]: string;
        };
        connected: Array<string>;
    };
};

export type Pty = {
    id: string;
    title: string;
    command: string;
    args: Array<string>;
    cwd: string;
    status: "running" | "exited";
    pid: number;
    exitCode?: number;
};

export type QuestionAnswer = Array<string>;

export type QuestionOption = {
    /**
     * Display text (1-5 words, concise)
     */
    label: string;
    /**
     * Explanation of choice
     */
    description: string;
};

export type QuestionTool = {
    messageID: string;
    callID: string;
};

export type QuestionV2Answer = Array<string>;

export type QuestionV2Info = {
    /**
     * Complete question
     */
    question: string;
    /**
     * Very short label (max 30 chars)
     */
    header: string;
    /**
     * Available choices
     */
    options: Array<QuestionV2Option>;
    multiple?: boolean;
    custom?: boolean;
};

export type QuestionV2Option = {
    /**
     * Display text (1-5 words, concise)
     */
    label: string;
    /**
     * Explanation of choice
     */
    description: string;
};

export type QuestionV2Tool = {
    messageID: string;
    callID: string;
};

export type Range = {
    start: {
        line: number;
        character: number;
    };
    end: {
        line: number;
        character: number;
    };
};

export type ReasoningPart = {
    id: string;
    sessionID: string;
    messageID: string;
    type: "reasoning";
    text: string;
    metadata?: {
        [key: string]: unknown;
    };
    time: {
        start: number;
        end?: number;
    };
};

export type ResourceSource = {
    text: FilePartSourceText;
    type: "resource";
    clientName: string;
    uri: string;
};

export type RetryPart = {
    id: string;
    sessionID: string;
    messageID: string;
    type: "retry";
    attempt: number;
    error: ApiError;
    time: {
        created: number;
    };
};

export type RevertState = {
    messageID: string;
    partID?: string;
    snapshot?: string;
    diff?: string;
    files?: Array<FileDiff>;
};

export type ServerConfig = {
    port?: number;
    hostname?: string;
    mdns?: boolean;
    mdnsDomain?: string;
    cors?: Array<string>;
};

export type SessionErrorUnknown = {
    type: "unknown";
    message: string;
};

export type SessionNextRetryError = {
    message: string;
    statusCode?: number;
    isRetryable: boolean;
    responseHeaders?: {
        [key: string]: string;
    };
    responseBody?: string;
    metadata?: {
        [key: string]: string;
    };
};

export type SnapshotFileDiff = {
    file?: string;
    patch?: string;
    additions: number;
    deletions: number;
    status?: "added" | "deleted" | "modified";
};

export type SnapshotPart = {
    id: string;
    sessionID: string;
    messageID: string;
    type: "snapshot";
    snapshot: string;
};

export type StepFinishPart = {
    id: string;
    sessionID: string;
    messageID: string;
    type: "step-finish";
    reason: string;
    snapshot?: string;
    cost: number;
    tokens: {
        total?: number;
        input: number;
        output: number;
        reasoning: number;
        cache: {
            read: number;
            write: number;
        };
    };
};

export type StepStartPart = {
    id: string;
    sessionID: string;
    messageID: string;
    type: "step-start";
    snapshot?: string;
};

export type StructuredOutputError = {
    name: "StructuredOutputError";
    data: {
        message: string;
        retries: number;
    };
};

export type SubtaskPart = {
    id: string;
    sessionID: string;
    messageID: string;
    type: "subtask";
    prompt: string;
    description: string;
    agent: string;
    model?: {
        providerID: string;
        modelID: string;
    };
    command?: string;
};

export type SymbolSource = {
    text: FilePartSourceText;
    type: "symbol";
    path: string;
    range: Range;
    name: string;
    kind: number;
};

export type TextPart = {
    id: string;
    sessionID: string;
    messageID: string;
    type: "text";
    text: string;
    synthetic?: boolean;
    ignored?: boolean;
    time?: {
        start: number;
        end?: number;
    };
    metadata?: {
        [key: string]: unknown;
    };
};

export type ToolFileContent = {
    type: "file";
    uri: string;
    mime: string;
    name?: string;
};

export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError;

export type ToolStateCompleted = {
    status: "completed";
    input: {
        [key: string]: unknown;
    };
    output: string;
    title: string;
    metadata: {
        [key: string]: unknown;
    };
    time: {
        start: number;
        end: number;
        compacted?: number;
    };
    attachments?: Array<FilePart>;
};

export type ToolStateError = {
    status: "error";
    input: {
        [key: string]: unknown;
    };
    error: string;
    metadata?: {
        [key: string]: unknown;
    };
    time: {
        start: number;
        end: number;
    };
};

export type ToolStatePending = {
    status: "pending";
    input: {
        [key: string]: unknown;
    };
    raw: string;
};

export type ToolStateRunning = {
    status: "running";
    input: {
        [key: string]: unknown;
    };
    title?: string;
    metadata?: {
        [key: string]: unknown;
    };
    time: {
        start: number;
    };
};

export type ToolTextContent = {
    type: "text";
    text: string;
};

export type UnknownError = {
    name: "UnknownError";
    data: {
        message: string;
        ref?: string;
    };
};

export type UserMessage = {
    id: string;
    sessionID: string;
    role: "user";
    time: {
        created: number;
    };
    format?: OutputFormat;
    summary?: {
        title?: string;
        body?: string;
        diffs: Array<SnapshotFileDiff>;
    };
    agent: string;
    model: {
        providerID: string;
        modelID: string;
        variant?: string;
    };
    system?: string;
    tools?: {
        [key: string]: boolean;
    };
};
