/** @jsxImportSource react */
import * as React from "react";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import type { OpenTargetRange } from "./open-target";
import { MarkdownBlock } from "../surface/markdown";

interface PreviewLoadingProps extends React.ComponentProps<"div"> {}

export function PreviewLoading({ className, ...props }: PreviewLoadingProps) {
  return (
    <div className={cn("flex h-full items-center justify-center text-muted-foreground", className)} {...props}>
      <Loader2 className="size-4 animate-spin" />
    </div>
  );
}

interface PreviewErrorProps extends React.ComponentProps<"div"> {
  message: string;
}

export function PreviewError({ message, className, ...props }: PreviewErrorProps) {
  return <div className={cn("p-4 text-sm text-muted-foreground", className)} {...props}>{message}</div>;
}

interface PlainTextProps extends React.ComponentProps<"pre"> {
  content: string;
  /** A read's line range: scroll there and highlight it. */
  range?: OpenTargetRange;
}

const RANGE_CONTEXT_LINES = 200;

function TextPreview({ content, range, className, ...props }: Omit<PlainTextProps, "range"> & { range: OpenTargetRange }) {
  const firstLineRef = React.useRef<HTMLSpanElement>(null);
  const [showAll, setShowAll] = React.useState(false);
  const lines = React.useMemo(() => content.split("\n"), [content]);
  const start = Math.max(1, Math.min(range.start, lines.length));
  const end = Math.max(start, Math.min(range.end, lines.length));
  const windowStart = showAll ? 1 : Math.max(1, start - RANGE_CONTEXT_LINES);
  const windowEnd = showAll ? lines.length : Math.min(lines.length, end + RANGE_CONTEXT_LINES);
  const visible = lines.slice(windowStart - 1, windowEnd);

  React.useEffect(() => {
    firstLineRef.current?.scrollIntoView({ block: "center" });
  }, [content, range.start, range.end]);

  return (
    <pre
      data-preview-range={`${start}-${end}`}
      className={cn("h-full overflow-auto p-4 text-xs leading-5 text-foreground", className)}
      {...props}
    >
      {visible.map((line, index) => {
        const lineNumber = windowStart + index;
        const highlighted = lineNumber >= start && lineNumber <= end;
        return (
          <span
            key={lineNumber}
            ref={lineNumber === start ? firstLineRef : undefined}
            className={cn("block whitespace-pre-wrap break-words rounded-sm", highlighted && "bg-amber-3/50")}
          >
            <span
              aria-hidden="true"
              className={cn("me-3 inline-block w-10 select-none text-right text-muted-foreground/50", highlighted && "text-amber-11")}
            >
              {lineNumber}
            </span>
            <span>{line || " "}</span>
          </span>
        );
      })}
      {visible.length < lines.length ? (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-2 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Show all {lines.length} lines
        </button>
      ) : null}
    </pre>
  );
}

export function PlainText({ content, range, className, ...props }: PlainTextProps) {
  if (range) return <TextPreview content={content} range={range} className={cn("font-mono", className)} {...props} />;
  return <pre className={cn("h-full overflow-auto p-4 text-xs leading-5 text-foreground whitespace-pre-wrap", className)} {...props}>{content}</pre>;
}

interface MarkdownPreviewProps extends React.ComponentProps<"div"> {
  content: string;
}

export function MarkdownPreview({ content, className, ...props }: MarkdownPreviewProps) {
  return (
    <div data-sofia-markdown-preview="" className={cn("h-full overflow-auto p-4", className)} {...props}>
      <MarkdownBlock text={content} />
    </div>
  );
}

interface TextHTMLPreviewProps {
  type: "text";
  title: string;
  content: string;
}

interface BinaryHTMLPreviewProps {
  type: "binary";
  title: string;
  url: string;
}

type HTMLPreviewProps = { className?: string } & (TextHTMLPreviewProps | BinaryHTMLPreviewProps);

export function HTMLPreview({ className, ...props }: HTMLPreviewProps) {
  if (props.type === "text") {
    return <iframe srcDoc={props.content} title={props.title} className={cn("h-full w-full border-0", className)} sandbox="allow-scripts allow-same-origin" />;
  }

  return <iframe src={props.url} title={props.title} className={cn("h-full w-full border-0", className)} sandbox="allow-scripts allow-same-origin" />;
}

interface PdfPreviewProps {
  url: string;
  title: string;
  className?: string;
}

export function PdfPreview({ url, title, className }: PdfPreviewProps) {
  // Chromium's built-in PDF viewer (enabled via webPreferences.plugins) renders
  // reliably through <embed>; <object>/sandboxed <iframe> show a blank frame.
  // The blob URL comes from a trusted workspace file.
  return <embed src={url} type="application/pdf" title={title} className={cn("h-full w-full border-0", className)} />;
}

interface ImagePreviewProps extends React.ComponentProps<"div"> {
  src: string;
  alt: string;
}

export function ImagePreview({ src, alt, className, ...props }: ImagePreviewProps) {
  return (
    <div className={cn("flex h-full items-center justify-center overflow-auto bg-muted/30 p-3", className)} {...props}>
      <img src={src} alt={alt} className="max-h-full max-w-full object-contain" />
    </div>
  );
}

interface PreviewUnavailableProps extends React.ComponentProps<"div"> {}

export function PreviewUnavailable({ className, ...props }: PreviewUnavailableProps) {
  return <div className={cn("p-4 text-sm text-muted-foreground", className)} {...props}>Preview unavailable. Open externally to view this file.</div>;
}
