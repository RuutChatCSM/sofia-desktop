"use client"

import * as React from "react"
import { ArrowUpRight, Check, Square, Undo2, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { ToolImage } from "@/lib/tool-images"
import { cn } from "@/lib/utils"

type Point = { x: number; y: number }
type Shape = { kind: "rect" | "arrow"; start: Point; end: Point }

type ToolImageAnnotatorProps = {
  image: ToolImage
  onSubmit: (note: string, dataUrl: string) => void
  onCancel: () => void
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function drawShape(
  context: CanvasRenderingContext2D,
  shape: Shape,
  width: number,
  height: number,
  color: string,
  lineWidth: number,
) {
  const startX = shape.start.x * width
  const startY = shape.start.y * height
  const endX = shape.end.x * width
  const endY = shape.end.y * height
  context.save()
  context.strokeStyle = color
  context.fillStyle = color
  context.lineWidth = lineWidth
  context.lineCap = "round"
  context.lineJoin = "round"
  if (shape.kind === "rect") {
    context.strokeRect(
      Math.min(startX, endX),
      Math.min(startY, endY),
      Math.abs(endX - startX),
      Math.abs(endY - startY),
    )
  } else {
    context.beginPath()
    context.moveTo(startX, startY)
    context.lineTo(endX, endY)
    context.stroke()
    const angle = Math.atan2(endY - startY, endX - startX)
    const head = Math.max(lineWidth * 3, Math.min(width, height) * 0.025)
    context.beginPath()
    context.moveTo(endX, endY)
    context.lineTo(endX - head * Math.cos(angle - Math.PI / 7), endY - head * Math.sin(angle - Math.PI / 7))
    context.lineTo(endX - head * Math.cos(angle + Math.PI / 7), endY - head * Math.sin(angle + Math.PI / 7))
    context.closePath()
    context.fill()
  }
  context.restore()
}

/**
 * A small canvas annotator for screenshots that never lived in a browser tab:
 * boxes and arrows in the accent colour, undo, and a note. The exported PNG is
 * handed to the same composer annotation event the browser uses.
 */
export function ToolImageAnnotator({ image, onSubmit, onCancel }: ToolImageAnnotatorProps) {
  const [tool, setTool] = React.useState<"rect" | "arrow">("rect")
  const [shapes, setShapes] = React.useState<Shape[]>([])
  const [draft, setDraft] = React.useState<Shape | null>(null)
  const [note, setNote] = React.useState("")
  const [loadedImage, setLoadedImage] = React.useState<HTMLImageElement | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [accent, setAccent] = React.useState("#3b82f6")
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const draftRef = React.useRef<Shape | null>(null)

  React.useEffect(() => {
    const probe = document.createElement("span")
    probe.style.color = "var(--primary)"
    probe.style.position = "absolute"
    probe.style.visibility = "hidden"
    document.body.appendChild(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    if (color) setAccent(color)
  }, [])

  React.useEffect(() => {
    let cancelled = false
    const element = new Image()
    element.crossOrigin = "anonymous"
    element.onload = () => {
      if (!cancelled) setLoadedImage(element)
    }
    element.onerror = () => {
      if (!cancelled) setError("Could not load this screenshot for annotation.")
    }
    element.src = image.src
    return () => {
      cancelled = true
      element.onload = null
      element.onerror = null
    }
  }, [image.src])

  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !loadedImage) return
    const width = loadedImage.naturalWidth
    const height = loadedImage.naturalHeight
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext("2d")
    if (!context) return
    context.clearRect(0, 0, width, height)
    context.drawImage(loadedImage, 0, 0, width, height)
    const lineWidth = Math.max(3, Math.round(width / 350))
    const drawn = draft ? [...shapes, draft] : shapes
    for (const shape of drawn) drawShape(context, shape, width, height, accent, lineWidth)
  }, [loadedImage, shapes, draft, accent])

  const pointFromEvent = (event: React.PointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect()
    return {
      x: clamp01((event.clientX - rect.left) / rect.width),
      y: clamp01((event.clientY - rect.top) / rect.height),
    }
  }

  const updateDraft = (shape: Shape | null) => {
    draftRef.current = shape
    setDraft(shape)
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!loadedImage) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = pointFromEvent(event)
    updateDraft({ kind: tool, start: point, end: point })
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const current = draftRef.current
    if (!current) return
    updateDraft({ ...current, end: pointFromEvent(event) })
  }

  const finishPointer = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const current = draftRef.current
    if (current) {
      const distance = Math.hypot(current.end.x - current.start.x, current.end.y - current.start.y)
      if (distance > 0.005) setShapes((all) => [...all, current])
    }
    updateDraft(null)
  }

  const handleSubmit = () => {
    const canvas = canvasRef.current
    if (!canvas || !note.trim()) return
    try {
      onSubmit(note, canvas.toDataURL("image/png"))
    } catch {
      setError("This screenshot cannot be exported because of browser security restrictions.")
    }
  }

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-2" data-testid="tool-image-annotator">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          size="sm"
          variant={tool === "rect" ? "secondary" : "ghost"}
          aria-pressed={tool === "rect"}
          onClick={() => setTool("rect")}
        >
          <Square aria-hidden="true" />
          Box
        </Button>
        <Button
          type="button"
          size="sm"
          variant={tool === "arrow" ? "secondary" : "ghost"}
          aria-pressed={tool === "arrow"}
          onClick={() => setTool("arrow")}
        >
          <ArrowUpRight aria-hidden="true" />
          Arrow
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Undo annotation"
          disabled={shapes.length === 0}
          onClick={() => setShapes((all) => all.slice(0, -1))}
        >
          <Undo2 aria-hidden="true" />
        </Button>
        <span className="text-xs text-white/60">Draw on the screenshot, then add a note.</span>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Cancel annotation"
          className="ms-auto"
          onClick={onCancel}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`Annotate ${image.alt}`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishPointer}
          onPointerCancel={finishPointer}
          className={cn(
            "max-h-full max-w-full touch-none cursor-crosshair rounded-xl border border-white/10 bg-black/20 shadow-2xl",
            !loadedImage && "opacity-0",
          )}
        />
      </div>
      <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-end">
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={2}
          placeholder="What should the agent know about this screenshot?"
          aria-label="Annotation note"
          className="min-h-[60px] flex-1 resize-none rounded-xl border border-border/60 bg-background/95 px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        />
        <Button type="button" onClick={handleSubmit} disabled={!note.trim() || !loadedImage} className="shrink-0">
          <Check aria-hidden="true" />
          Add to message
        </Button>
      </div>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </div>
  )
}
