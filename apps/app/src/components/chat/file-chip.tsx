"use client"

import { ArrowUpRight, FileText } from "lucide-react"

import { useOpenArtifactPath } from "@/lib/artifacts"
import type { OpenTargetRange } from "@/react-app/domains/session/artifacts/open-target"
import { cn } from "@/lib/utils"

type FileChipProps = {
  /** Full (possibly absolute) file path; only the basename is shown. */
  path: string
  className?: string
  /** Read line range: open the preview scrolled to it and highlighted. */
  range?: OpenTargetRange
  /** Edit/write/apply_patch: open the call's diff instead of the final file. */
  diff?: string
  /** A failed read of a missing file must not open an empty preview. */
  unavailable?: boolean
}

function baseName(path: string): string {
  const segments = path.split(/[/\\]/)
  return segments[segments.length - 1] || path
}

/**
 * Paper "File paths → chips": never render raw absolute paths. A file
 * reference is an inline chip — icon + basename in mono, full path in
 * the tooltip. Click opens the artifact preview at the line or diff the
 * call touched; ↗ opens the file in the default app. Used in aggregate
 * rows, failure reasons, and prose.
 */
export function FileChip({ path, className, range, diff, unavailable = false }: FileChipProps) {
  const openArtifactPath = useOpenArtifactPath()
  const name = baseName(path)
  const openOptions = {
    ...(range ? { range } : {}),
    ...(diff ? { diff } : {}),
  }
  const title = unavailable
    ? `${path} — file not found`
    : range
      ? `${path}:${range.start}-${range.end}`
      : path

  if (unavailable) {
    return (
      <span
        aria-disabled="true"
        title={title}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border border-border/50 bg-muted/30 px-1.5 py-0.5 text-muted-foreground opacity-60",
          className,
        )}
      >
        <FileText aria-hidden="true" className="size-3 shrink-0" />
        <span className="min-w-0 truncate font-mono text-[11px] leading-4 line-through decoration-muted-foreground/50">
          {name}
        </span>
        <span className="shrink-0 text-[10px]">not found</span>
      </span>
    )
  }

  return (
    <span
      className={cn(
        "inline-flex items-stretch overflow-hidden rounded-md border border-border/70 bg-muted/50 align-middle",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => openArtifactPath(path, openOptions)}
        title={title}
        className="flex min-w-0 cursor-pointer items-center gap-1.5 px-1.5 py-0.5 transition-colors hover:bg-muted"
      >
        <FileText aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-mono text-[11px] leading-4 text-foreground">
          {name}
        </span>
      </button>
      <button
        type="button"
        onClick={() => openArtifactPath(path, { external: true })}
        title={`Open ${name} in default app`}
        aria-label={`Open ${name} in default app`}
        className="flex cursor-pointer items-center border-l border-border/60 px-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <ArrowUpRight aria-hidden="true" className="size-2.5" />
      </button>
    </span>
  )
}
