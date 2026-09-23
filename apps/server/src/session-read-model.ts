import { z } from "zod";
import type {
  EngineMessage,
  EngineSessionInfo,
  EngineSessionStatus,
  EngineTodo,
} from "./engine/workspace-engine-client.js";

import { ApiError } from "./errors.js";

const sessionTimeSchema = z
  .object({
    created: z.number().optional(),
    updated: z.number().optional(),
    completed: z.number().optional(),
    archived: z.number().optional(),
  })
  .passthrough();

const sessionSummarySchema = z
  .object({
    additions: z.number().optional(),
    deletions: z.number().optional(),
    files: z.number().optional(),
  })
  .passthrough();

export const sessionStatusSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("idle") }),
  z.object({ type: z.literal("busy") }),
  z.object({ type: z.literal("retry"), attempt: z.number(), message: z.string(), next: z.number() }),
]);

export const sessionTodoSchema = z
  .object({
    content: z.string(),
    status: z.string(),
    priority: z.string(),
  })
  .passthrough();

export const sessionInfoSchema = z
  .object({
    id: z.string(),
    title: z.string().nullish(),
    slug: z.string().nullish(),
    parentID: z.string().nullish(),
    directory: z.string().nullish(),
    time: sessionTimeSchema.optional(),
    summary: sessionSummarySchema.optional(),
  })
  .passthrough();

const sessionMessageInfoSchema = z
  .object({
    id: z.string(),
    sessionID: z.string(),
    role: z.string(),
    parentID: z.string().nullish(),
    time: sessionTimeSchema.optional(),
  })
  .passthrough();

const sessionPartSchema = z
  .object({
    id: z.string(),
    messageID: z.string(),
    sessionID: z.string(),
  })
  .passthrough();

export const sessionMessageSchema = z
  .object({
    info: sessionMessageInfoSchema,
    parts: z.array(sessionPartSchema),
  })
  .passthrough();

const sessionListSchema = z.array(sessionInfoSchema);
const sessionMessagesSchema = z.array(sessionMessageSchema);
const sessionTodosSchema = z.array(sessionTodoSchema);
const sessionStatusesSchema = z.record(z.string(), sessionStatusSchema);

const sessionSnapshotSchema = z.object({
  session: sessionInfoSchema,
  messages: sessionMessagesSchema,
  todos: sessionTodosSchema,
  status: sessionStatusSchema,
});

export type SessionInfoReadModel = z.infer<typeof sessionInfoSchema>;
export type SessionMessageReadModel = z.infer<typeof sessionMessageSchema>;
export type SessionTodoReadModel = z.infer<typeof sessionTodoSchema>;
export type SessionStatusReadModel = z.infer<typeof sessionStatusSchema>;
export type SessionSnapshotReadModel = z.infer<typeof sessionSnapshotSchema>;

const IDLE_STATUS: SessionStatusReadModel = { type: "idle" };

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ApiError(502, "opencode_invalid_response", `OpenCode returned invalid ${label}`, {
    issues: result.error.issues,
  });
}

export function buildSessionList(value: EngineSessionInfo[]): SessionInfoReadModel[] {
  return parseOrThrow(sessionListSchema, value, "session list");
}

export function buildSession(value: EngineSessionInfo): SessionInfoReadModel {
  return parseOrThrow(sessionInfoSchema, value, "session");
}

export function buildSessionMessages(value: EngineMessage[]): SessionMessageReadModel[] {
  return parseOrThrow(sessionMessagesSchema, value, "session messages");
}

export function buildSessionTodos(value: EngineTodo[]): SessionTodoReadModel[] {
  return parseOrThrow(sessionTodosSchema, value, "session todos");
}

export function buildSessionStatuses(value: Record<string, EngineSessionStatus>): Record<string, SessionStatusReadModel> {
  return parseOrThrow(sessionStatusesSchema, value, "session statuses");
}

export function buildSessionSnapshot(input: {
  session: EngineSessionInfo;
  messages: EngineMessage[];
  todos: EngineTodo[];
  statuses: Record<string, EngineSessionStatus>;
}): SessionSnapshotReadModel {
  const session = buildSession(input.session);
  const messages = buildSessionMessages(input.messages);
  const todos = buildSessionTodos(input.todos);
  const statuses = buildSessionStatuses(input.statuses);
  return parseOrThrow(
    sessionSnapshotSchema,
    {
      session,
      messages,
      todos,
      status: statuses[session.id] ?? IDLE_STATUS,
    },
    "session snapshot",
  );
}
