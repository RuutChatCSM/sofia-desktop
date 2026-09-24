import { z } from "zod"

import {
  sofiaAffordanceDescriptorSchema,
  sofiaProviderRefSchema,
} from "./sofia-affordance.js"
import { sofiaFeatureContributionSchema } from "./sofia-provider.js"

export const SOFIA_CONTEXT_SCHEMA_VERSION = 1

export const sofiaSessionRefSchema = z.object({
  workspaceId: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
  title: z.string().optional(),
})
export type SofiaSessionRef = z.infer<typeof sofiaSessionRefSchema>

export const sofiaScreenSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("conversation"),
    route: z.string(),
    workspaceId: z.string().optional(),
    sessionId: z.string().optional(),
  }),
  z.object({
    kind: z.literal("settings"),
    route: z.string(),
    workspaceId: z.string().optional(),
    panel: z.string(),
  }),
  z.object({
    kind: z.literal("other"),
    route: z.string(),
  }),
])
export type SofiaScreen = z.infer<typeof sofiaScreenSchema>

export const sofiaConversationLayoutSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("empty") }),
  z.object({
    kind: z.literal("single"),
    sessionId: z.string(),
  }),
  z.object({
    kind: z.literal("split"),
    primarySessionId: z.string(),
    secondarySessionId: z.string(),
    focused: z.enum(["primary", "secondary"]),
  }),
])
export type SofiaConversationLayout = z.infer<typeof sofiaConversationLayoutSchema>

export const sofiaPanelTabSchema = z.object({
  id: z.string(),
  kind: z.enum(["browser", "artifact"]),
  label: z.string(),
  url: z.string().optional(),
  status: z.enum(["loading", "ready"]).optional(),
})
export type SofiaPanelTab = z.infer<typeof sofiaPanelTabSchema>

export const sofiaResourceDescriptorSchema = z.object({
  ref: z.string().trim().min(1),
  kind: z.enum(["workspace", "session", "screen", "side-panel", "settings"]),
  title: z.string(),
  provider: sofiaProviderRefSchema,
  state: z.record(z.string(), z.unknown()),
})
export type SofiaResourceDescriptor = z.infer<typeof sofiaResourceDescriptorSchema>

export const sofiaContextSnapshotSchema = z.object({
  schemaVersion: z.literal(SOFIA_CONTEXT_SCHEMA_VERSION),
  revision: z.number().int().nonnegative(),
  capturedAt: z.string(),
  screen: sofiaScreenSchema,
  conversations: z.object({
    tabs: z.array(sofiaSessionRefSchema),
    layout: sofiaConversationLayoutSchema,
  }),
  chrome: z.object({
    sidebarOpen: z.boolean(),
    applicationMenuVisible: z.boolean(),
    rightSidebarExpanded: z.boolean(),
  }),
  execution: z.object({
    queries: z.literal("parallel"),
    commands: z.literal("serialized"),
    busyCommandId: z.string().nullable(),
    busyActor: z.string().nullable(),
  }),
  sidePanel: z.object({
    open: z.boolean(),
    ownerSessionId: z.string().nullable(),
    kind: z.enum(["panel", "extensions", "voice"]).nullable(),
    tabs: z.array(sofiaPanelTabSchema),
    activeTabId: z.string().nullable(),
  }),
  resources: z.array(sofiaResourceDescriptorSchema),
  availableAffordances: z.array(sofiaAffordanceDescriptorSchema),
  contributions: z.array(sofiaFeatureContributionSchema),
})
export type SofiaContextSnapshot = z.infer<typeof sofiaContextSnapshotSchema>
