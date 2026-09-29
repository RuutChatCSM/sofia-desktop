import { StateEffect, StateField, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { highlightCode } from "../changes/diff-highlight";

// Token colours decorate the actual editable document; edits, undo and selection
// keep using CodeMirror. Stale asynchronous results never colour a newer draft.
export function sourceHighlighting(path: string) {
  const setTokens = StateEffect.define<DecorationSet>();
  const tokens = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(value, transaction) {
      if (transaction.docChanged) value = Decoration.none;
      for (const effect of transaction.effects) if (effect.is(setTokens)) value = effect.value;
      return value;
    },
    provide: (field) => EditorView.decorations.from(field),
  });
  const plugin = ViewPlugin.fromClass(class {
    version = 0;
    timer: ReturnType<typeof setTimeout> | undefined;
    constructor(readonly view: EditorView) { this.schedule(); }
    update(update: ViewUpdate) { if (update.docChanged) this.schedule(); }
    schedule() {
      const version = ++this.version;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { void this.colour(version); }, 120);
    }
    async colour(version: number) {
      const source = this.view.state.doc.toString();
      if (source.length > 200_000) return;
      const lines = await highlightCode(source, path);
      if (version !== this.version) return;
      const ranges: Range<Decoration>[] = [];
      let offset = 0;
      for (const line of lines) {
        for (const token of line) {
          const end = offset + token.text.length;
          if (token.color && end > offset) ranges.push(Decoration.mark({ attributes: { style: `color:${token.color}`, "data-source-token": "" } }).range(offset, end));
          offset = end;
        }
        offset += 1;
      }
      this.view.dispatch({ effects: setTokens.of(Decoration.set(ranges)) });
    }
    destroy() { this.version += 1; clearTimeout(this.timer); }
  });
  return [tokens, plugin];
}
