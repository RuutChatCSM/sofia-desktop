import { and, asc, desc, eq, isNull } from "@sofia-ee/den-db/drizzle"
import {
  WorkerInstanceTable,
  WorkerTable,
  WorkerTokenTable,
} from "@sofia-ee/den-db/schema"
import type { DenTypeId } from "@sofia-ee/utils/typeid"
import { db } from "../db.js"
import { env } from "../env.js"
import { customDomainForWorker } from "./vanity-domain.js"

/** Reachable base URLs and paired tokens for talking to one healthy cloud worker. */
export type CloudWorkerAccess = {
  candidates: string[]
  clientToken: string
  hostToken: string
  workerId: DenTypeId<"worker">
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "")
}

function workerIsHealthy(workerStatus: string, instanceStatus: string): boolean {
  return workerStatus === "healthy" && instanceStatus === "healthy"
}

function workerCandidates(workerId: DenTypeId<"worker">, instanceUrl: string): string[] {
  const candidates: string[] = []
  const vanityHostname = customDomainForWorker(workerId, env.render.workerPublicDomainSuffix)
  if (vanityHostname) candidates.push(`https://${vanityHostname}`)

  const normalizedInstanceUrl = normalizeUrl(instanceUrl)
  if (normalizedInstanceUrl && !candidates.includes(normalizedInstanceUrl)) {
    candidates.push(normalizedInstanceUrl)
  }
  return candidates
}

/**
 * Resolve how to reach an organization's worker, or null when it is not usable.
 *
 * Null covers every unusable case — worker missing, not owned by the
 * organization, unhealthy worker or instance, or missing host/client tokens —
 * so callers treat "cannot reach this worker" as one branch.
 */
export async function loadCloudWorkerAccess(input: {
  organizationId: DenTypeId<"organization">
  workerId: DenTypeId<"worker">
}): Promise<CloudWorkerAccess | null> {
  const workerRows = await db
    .select({ id: WorkerTable.id, status: WorkerTable.status })
    .from(WorkerTable)
    .where(and(
      eq(WorkerTable.id, input.workerId),
      eq(WorkerTable.org_id, input.organizationId),
      eq(WorkerTable.status, "healthy"),
    ))
    .limit(1)

  if (!workerRows[0]) return null

  const [instances, tokens] = await Promise.all([
    db
      .select({ status: WorkerInstanceTable.status, url: WorkerInstanceTable.url })
      .from(WorkerInstanceTable)
      .where(eq(WorkerInstanceTable.worker_id, input.workerId))
      .orderBy(desc(WorkerInstanceTable.created_at))
      .limit(1),
    db
      .select({ scope: WorkerTokenTable.scope, token: WorkerTokenTable.token })
      .from(WorkerTokenTable)
      .where(and(eq(WorkerTokenTable.worker_id, input.workerId), isNull(WorkerTokenTable.revoked_at)))
      .orderBy(asc(WorkerTokenTable.created_at)),
  ])

  const instanceUrl = instances[0]?.url
  const instanceStatus = instances[0]?.status
  const hostToken = tokens.find((entry) => entry.scope === "host")?.token
  const clientToken = tokens.find((entry) => entry.scope === "client")?.token
  if (
    !instanceUrl
    || !instanceStatus
    || !workerIsHealthy(workerRows[0].status, instanceStatus)
    || !hostToken
    || !clientToken
  ) return null

  return {
    candidates: workerCandidates(input.workerId, instanceUrl),
    clientToken,
    hostToken,
    workerId: input.workerId,
  }
}
