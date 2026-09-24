import type { WorkflowVersion } from "@sofia/types/workflows"

export function redactWorkflowNormalizedPayloadAuthoringDetails(
  payload: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!payload) return null
  return Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "exampleInput"))
}

export function redactWorkflowVersionAuthoringDetails(
  version: WorkflowVersion,
): WorkflowVersion {
  return {
    ...version,
    code: null,
    exampleInput: null,
    automationReferences: version.automationReferences.map((reference) => ({
      id: reference.id,
      name: reference.name,
      state: reference.state,
      configObjectVersionId: reference.configObjectVersionId,
    })),
  }
}
