/** @jsxImportSource react */
import { CornerDownRight, MoreHorizontal, Paperclip, Trash2 } from "lucide-react";
import { useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { t } from "@/i18n";
import type { ComposerDraft } from "@/app/types";
import type { QueuedComposerItem } from "@/react-app/domains/session/surface/composer-state-store";

export type QueuedMessagesPanelProps = {
  items: QueuedComposerItem[];
  onRemove: (id: string) => void;
  onSendNow: (id: string) => void;
  onReorder: (ids: string[]) => void;
  onEdit: (id: string, text: string) => void;
  sending?: boolean;
};

// Keep the pending row quiet: show a few stacked follow-ups, then a count.
const MAX_VISIBLE = 3;

/**
 * One-line preview of a queued draft. Inline tokens (attachments, pasted text,
 * skills) are collapsed to short labels so the row stays compact.
 */
function previewText(draft: ComposerDraft): string {
  const text = draft.text
    .replace(/\[attachment [^\]]+\]/g, " ")
    .replace(/\[pasted text ([^\]]+)\]/g, (_match, label: string) => `[pasted: ${label}]`)
    .replace(/\[connect-skill [^\]]+\]/g, "[skill]")
    .replace(/\[skill ([^\]]+)\]/g, "/$1")
    .replace(/\s+/g, " ")
    .trim();

  if (text) return text;
  if (draft.attachments.length > 0) {
    return t("composer.queued_attachments_only", { count: draft.attachments.length });
  }
  return "";
}

function QueuedRow(props: {
  item: QueuedComposerItem;
  ids: string[];
  index: number;
  sending?: boolean;
  onRemove: (id: string) => void;
  onSendNow: (id: string) => void;
  onReorder: (ids: string[]) => void;
  onEdit: (id: string, text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState(props.item.draft.text);

  const startEdit = () => {
    setDraftText(props.item.draft.text);
    setEditing(true);
  };

  const cancel = () => {
    setDraftText(props.item.draft.text);
    setEditing(false);
  };

  const commit = () => {
    const next = draftText.trim();
    setEditing(false);
    if (!next || next === props.item.draft.text) {
      setDraftText(props.item.draft.text);
      return;
    }
    props.onEdit(props.item.id, next);
  };

  const move = (delta: number) => {
    const to = props.index + delta;
    if (to < 0 || to >= props.ids.length) return;
    const next = [...props.ids];
    const [moved] = next.splice(props.index, 1);
    if (!moved) return;
    next.splice(to, 0, moved);
    props.onReorder(next);
  };

  if (editing) {
    return (
      <div className="rounded-xl border border-dls-border bg-dls-surface px-2.5 py-2">
        <textarea
          autoFocus
          value={draftText}
          rows={3}
          onChange={(event) => setDraftText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              cancel();
              return;
            }
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              commit();
            }
          }}
          className="w-full resize-none rounded-lg border border-dls-border bg-dls-surface-muted px-2 py-1.5 text-[13px] leading-5 text-dls-text outline-none focus:border-gray-8"
          aria-label={t("composer.queued_edit")}
        />
        <div className="mt-1.5 flex items-center justify-end gap-1.5">
          <button
            type="button"
            onClick={cancel}
            className="rounded-md px-2 py-1 text-[12px] text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={commit}
            className="rounded-md bg-gray-12 px-2.5 py-1 text-[12px] font-medium text-gray-1 transition-opacity hover:opacity-90"
          >
            {t("common.save")}
          </button>
        </div>
      </div>
    );
  }

  const preview = previewText(props.item.draft);
  const hasAttachments = props.item.draft.attachments.length > 0;

  return (
    <div className="flex h-9 items-center gap-2 rounded-xl border border-dls-border bg-dls-surface-muted px-2.5">
      <CornerDownRight size={14} className="shrink-0 text-gray-9" aria-hidden="true" />
      <button
        type="button"
        disabled={props.sending}
        onClick={startEdit}
        title={preview || t("composer.queued_edit")}
        className="min-w-0 flex-1 truncate text-left text-[13px] leading-5 text-gray-11 transition-colors hover:text-gray-12 disabled:pointer-events-none"
      >
        {hasAttachments ? (
          <Paperclip size={12} className="mr-1 inline align-text-bottom text-gray-9" aria-hidden="true" />
        ) : null}
        {preview}
      </button>
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          disabled={props.sending}
          onClick={() => props.onSendNow(props.item.id)}
          title={t("composer.queued_send_now_hint")}
          className="rounded-md px-2 py-1 text-[12px] font-medium text-gray-11 transition-colors hover:bg-gray-3 hover:text-gray-12 disabled:pointer-events-none disabled:opacity-40"
        >
          {t("composer.queued_steer")}
        </button>
        <button
          type="button"
          disabled={props.sending}
          onClick={() => props.onRemove(props.item.id)}
          title={t("common.remove")}
          aria-label={t("common.remove")}
          className="flex size-7 items-center justify-center rounded-md text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12 disabled:pointer-events-none disabled:opacity-40"
        >
          <Trash2 size={14} />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                disabled={props.sending}
                title={t("composer.queued_more_actions")}
                aria-label={t("composer.queued_more_actions")}
                className="flex size-7 items-center justify-center rounded-md text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12 disabled:pointer-events-none disabled:opacity-40"
              >
                <MoreHorizontal size={15} />
              </button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={startEdit}>{t("composer.queued_edit")}</DropdownMenuItem>
            <DropdownMenuItem disabled={props.index === 0} onClick={() => move(-1)}>
              {t("composer.queued_move_up")}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={props.index === props.ids.length - 1} onClick={() => move(1)}>
              {t("composer.queued_move_down")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

/**
 * Follow-up messages queued while the agent is busy. Compact rows sit directly
 * above the composer: click the text to edit inline, Steer to send into the
 * current run now, or use the menu to reorder.
 */
export function QueuedMessagesPanel(props: QueuedMessagesPanelProps) {
  if (props.items.length === 0) return null;

  const ids = props.items.map((item) => item.id);
  const visible = props.items.slice(0, MAX_VISIBLE);
  const hiddenCount = props.items.length - visible.length;

  return (
    <div className="flex flex-col gap-1.5">
      {visible.map((item, index) => (
        <QueuedRow
          key={item.id}
          item={item}
          ids={ids}
          index={index}
          sending={props.sending}
          onRemove={props.onRemove}
          onSendNow={props.onSendNow}
          onReorder={props.onReorder}
          onEdit={props.onEdit}
        />
      ))}
      {hiddenCount > 0 ? (
        <div className="px-2 text-[11px] text-gray-9">{t("composer.queued_more", { count: hiddenCount })}</div>
      ) : null}
    </div>
  );
}
