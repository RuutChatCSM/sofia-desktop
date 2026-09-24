/** @jsxImportSource react */

/**
 * Session-level notice rendered above the transcript. Carries engine warnings
 * and states the user would otherwise only see as an empty pane — a task held
 * by another Sofia process, or a transcript that could not be loaded.
 */
export function SessionNotice(props: { message: string }) {
  return (
    <div role="status" data-session-notice className="mx-auto mt-3 w-full max-w-[800px] px-5">
      <div className="rounded-xl border border-dls-border border-l-2 border-l-amber-9 bg-dls-hover px-4 py-2 text-xs text-dls-secondary">
        {props.message}
      </div>
    </div>
  );
}
