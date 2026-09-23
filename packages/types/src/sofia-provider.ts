import { z } from "zod"

import {
  sofiaAffordanceDescriptorSchema,
  sofiaProviderRefSchema,
} from "./sofia-affordance.js"

export const sofiaGuidanceDescriptorSchema = z.object({
  ref: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  provider: sofiaProviderRefSchema,
  loading: z.enum(["eager", "catalog", "on-demand"]),
})
export type SofiaGuidanceDescriptor = z.infer<typeof sofiaGuidanceDescriptorSchema>

export const sofiaFeatureContributionSchema = z.object({
  featureId: z.string().trim().min(1),
  provider: sofiaProviderRefSchema,
  affordances: z.array(sofiaAffordanceDescriptorSchema),
  guidance: z.array(sofiaGuidanceDescriptorSchema),
})
export type SofiaFeatureContribution = z.infer<typeof sofiaFeatureContributionSchema>

export const sofiaProviderCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  contributions: z.array(sofiaFeatureContributionSchema),
})
export type SofiaProviderCatalog = z.infer<typeof sofiaProviderCatalogSchema>

export const sofiaCapabilityResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    data: z.unknown(),
    additionalContext: z.array(z.string()).optional(),
  }),
  z.object({
    status: z.literal("guidance"),
    instructions: z.array(z.string()),
  }),
  z.object({
    status: z.literal("requires-user-action"),
    message: z.string(),
    action: z.string().optional(),
  }),
  z.object({
    status: z.literal("failed"),
    error: z.string(),
    retryable: z.boolean(),
  }),
])
export type SofiaCapabilityResult = z.infer<typeof sofiaCapabilityResultSchema>
