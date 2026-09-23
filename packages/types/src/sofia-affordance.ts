import { z } from "zod"

export const SOFIA_AFFORDANCE_SCHEMA_VERSION = 1

export const sofiaAffordanceKindSchema = z.enum(["query", "command", "guidance"])
export type SofiaAffordanceKind = z.infer<typeof sofiaAffordanceKindSchema>

export const sofiaProviderKindSchema = z.enum(["builtin", "extension", "mcp", "connect"])
export type SofiaProviderKind = z.infer<typeof sofiaProviderKindSchema>

export const sofiaProviderRefSchema = z.object({
  id: z.string().trim().min(1),
  kind: sofiaProviderKindSchema,
})
export type SofiaProviderRef = z.infer<typeof sofiaProviderRefSchema>

export const sofiaAffordanceArgumentSchema = z.object({
  name: z.string().trim().min(1),
  type: z.enum(["string", "number", "boolean", "object", "array", "unknown"]),
  required: z.boolean(),
  description: z.string().trim().min(1).optional(),
})
export type SofiaAffordanceArgument = z.infer<typeof sofiaAffordanceArgumentSchema>

export const sofiaAffordanceEffectsSchema = z.object({
  data: z.enum(["none", "read", "write"]),
  ui: z.enum(["none", "focus", "navigate", "layout", "dialog"]),
  external: z.boolean(),
})
export type SofiaAffordanceEffects = z.infer<typeof sofiaAffordanceEffectsSchema>

export const sofiaAffordanceAvailabilitySchema = z.object({
  enabled: z.boolean(),
  reason: z.string().trim().min(1).optional(),
})
export type SofiaAffordanceAvailability = z.infer<typeof sofiaAffordanceAvailabilitySchema>

export const sofiaAffordanceExecutorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sofia") }),
  z.object({
    kind: z.literal("tool"),
    tool: z.string().trim().min(1),
  }),
])
export type SofiaAffordanceExecutor = z.infer<typeof sofiaAffordanceExecutorSchema>

export const sofiaAffordanceDescriptorSchema = z.object({
  id: z.string().trim().min(1),
  kind: sofiaAffordanceKindSchema,
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  provider: sofiaProviderRefSchema,
  arguments: z.array(sofiaAffordanceArgumentSchema),
  effects: sofiaAffordanceEffectsSchema,
  confirmation: z.enum(["never", "destructive", "always"]),
  availability: sofiaAffordanceAvailabilitySchema,
  executor: sofiaAffordanceExecutorSchema,
})
export type SofiaAffordanceDescriptor = z.infer<typeof sofiaAffordanceDescriptorSchema>

export const sofiaAffordanceRequestSchema = z.object({
  id: z.string().trim().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
  actor: z.string().trim().min(1).optional(),
})
export type SofiaAffordanceRequest = z.infer<typeof sofiaAffordanceRequestSchema>

const sofiaAffordanceSuccessSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
  result: z.unknown().optional(),
  revision: z.number().int().nonnegative().optional(),
  effects: sofiaAffordanceEffectsSchema,
})

const sofiaAffordanceFailureSchema = z.object({
  ok: z.literal(false),
  id: z.string(),
  error: z.string(),
  code: z.enum(["unavailable", "invalid-args", "conflict", "failed"]),
  revision: z.number().int().nonnegative().optional(),
})

export const sofiaAffordanceResultSchema = z.discriminatedUnion("ok", [
  sofiaAffordanceSuccessSchema,
  sofiaAffordanceFailureSchema,
])
export type SofiaAffordanceResult = z.infer<typeof sofiaAffordanceResultSchema>
