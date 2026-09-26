import { codeToTokens, type BundledLanguage, type SpecialLanguage } from "shiki";

/**
 * Syntax highlighting for diff rows.
 *
 * Reuses the app's existing highlighter (shiki) rather than growing a second one,
 * but tokenises each side of a hunk *as a whole* so multi-line constructs — block
 * comments, template strings, JSX — read correctly, then splits the tokens back
 * into rows for the viewer. Highlighting is progressive: until it resolves the
 * viewer renders the plain text, so the diff is never wrong, only uncoloured.
 */
const LANGUAGE_BY_EXTENSION: Record<string, BundledLanguage | SpecialLanguage> = {
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "jsonc",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  vue: "vue",
  svelte: "svelte",
  md: "markdown",
  mdx: "mdx",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  php: "php",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "fish",
  ps1: "powershell",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  ini: "ini",
  sql: "sql",
  graphql: "graphql",
  diff: "diff",
  patch: "diff",
  txt: "text",
};

/** Shiki language id for a path; unknown extensions fall back to plain text. */
export function languageForPath(path: string): BundledLanguage | SpecialLanguage {
  const name = path.toLowerCase().split("/").pop() ?? "";
  const extension = name.includes(".") ? name.split(".").pop() ?? "" : name;
  return LANGUAGE_BY_EXTENSION[extension] ?? ("text" as SpecialLanguage);
}

/** Shiki theme for the diff: the app's surfaces are dark. */
export const DIFF_THEME = "github-dark";

export type HighlightedToken = { text: string; color?: string };
/** One line of tokens. */
export type HighlightedLine = HighlightedToken[];

export async function highlightCode(code: string, path: string): Promise<HighlightedLine[]> {
  const plain = (): HighlightedLine[] => code.split("\n").map((line) => [{ text: line }]);
  if (!code) return [];
  try {
    const { tokens } = await codeToTokens(code, { lang: languageForPath(path), theme: DIFF_THEME });
    return tokens.map((line) =>
      line.map((token) => ({ text: token.content, ...(token.color ? { color: token.color } : {}) })),
    );
  } catch {
    // An unknown language, or a shiki failure: uncoloured text is still correct.
    return plain();
  }
}

/**
 * One side of a hunk as plain source, in row order: context and deletions for the
 * old side, context and additions for the new. The viewer walks its rows against
 * these in the same order, so a token line always belongs to the line it is drawn
 * beside.
 */
export function hunkSideText(hunk: { lines: ReadonlyArray<{ type: "context" | "add" | "delete"; text: string }> }, side: "old" | "new"): string {
  const rows = hunk.lines.filter((line) => (side === "old" ? line.type !== "add" : line.type !== "delete"));
  return rows.map((line) => line.text).join("\n");
}
