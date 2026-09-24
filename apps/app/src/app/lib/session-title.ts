import { t } from "../../i18n";

/** Raw English string — used for prefix matching against stored titles. */
export const DEFAULT_SESSION_TITLE = "New session";

/** Placeholder a Sofia-engine task is created with, before the engine derives a
 * title from the first user message. Tasked sessions keep this title in older
 * stores, so it has to read as "no title yet" everywhere. */
export const PENDING_SESSION_TITLE = "New Sofia task";

const GENERATED_SESSION_TITLE_PREFIX = `${DEFAULT_SESSION_TITLE} - `;

export function isGeneratedSessionTitle(title: string | null | undefined) {
  const trimmed = title?.trim() ?? "";
  if (trimmed === PENDING_SESSION_TITLE) return true;
  if (!trimmed.startsWith(GENERATED_SESSION_TITLE_PREFIX)) return false;
  const suffix = trimmed.slice(GENERATED_SESSION_TITLE_PREFIX.length).trim();
  return Boolean(suffix) && Number.isFinite(Date.parse(suffix));
}

export function getDisplaySessionTitle(
  title: string | null | undefined,
  fallback?: string,
) {
  const trimmed = title?.trim() ?? "";
  if (!trimmed || isGeneratedSessionTitle(trimmed)) return fallback ?? t("session.default_title");
  return trimmed;
}
