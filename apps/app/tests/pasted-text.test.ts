import { describe, expect, test } from "bun:test";
import {
  INLINE_PASTE_BUDGET_BYTES,
  createPastedTextChip,
  createPastedTextFile,
  isInlinePaste,
  resolvePastedTextPlaceholders,
  shouldCollapsePastedText,
  utf8ByteLength,
} from "../src/react-app/domains/session/surface/composer/pasted-text";

describe("pasted text collapse policy", () => {
  test("keeps text that fits without scrolling directly in the text field", () => {
    expect(shouldCollapsePastedText("Short paste", false)).toBeFalse();
  });

  test("collapses text that would make the composer scroll", () => {
    expect(shouldCollapsePastedText("Long paste", true)).toBeTrue();
  });

  test("does not collapse standalone HTTP or HTTPS URLs", () => {
    expect(shouldCollapsePastedText("https://example.com/long-url", true)).toBeFalse();
    expect(shouldCollapsePastedText("http://example.com/long-url", true)).toBeFalse();
  });

  test("only exempts URLs that are the whole paste with no whitespace", () => {
    const longUrl = "https://example.com/long-url";
    expect(shouldCollapsePastedText(`${longUrl} `, true)).toBeTrue();
    expect(shouldCollapsePastedText(`Read ${longUrl}`, true)).toBeTrue();
  });

  test("an oversized paste becomes a resource, not inline prompt text", () => {
    const huge = "x".repeat(INLINE_PASTE_BUDGET_BYTES + 1);
    const small = "first\nsecond";

    expect(isInlinePaste(small)).toBeTrue();
    expect(isInlinePaste(huge)).toBeFalse();

    const bigChip = createPastedTextChip(huge);
    const smallChip = createPastedTextChip(small);
    expect(bigChip.inline).toBeFalse();
    expect(smallChip.inline).toBeTrue();

    // The model gets the small paste inline and only a reference for the big
    // one — otherwise a collapsed chip would still burn the whole context.
    const draft = `Review [pasted text ${smallChip.label}] and [pasted text ${bigChip.label}]`;
    const resolved = resolvePastedTextPlaceholders(draft, [smallChip, bigChip]);
    expect(resolved).toContain("first\nsecond");
    expect(resolved).toContain(`[pasted text ${bigChip.label}]`);
    expect(resolved).not.toContain(huge);

    const file = createPastedTextFile(bigChip);
    expect(file.type).toStartWith("text/plain");
    expect(file.name).toEndWith(".txt");
    expect(file.size).toBe(utf8ByteLength(huge));
  });

  test("creates a reusable chip and resolves it before submission", () => {
    const pasted = createPastedTextChip("first\nsecond");
    expect(pasted.id).toStartWith("paste-");
    expect(pasted.label).toEndWith("· 2 lines");
    expect(pasted.lines).toBe(2);
    expect(
      resolvePastedTextPlaceholders(`Before [pasted text ${pasted.label}] after`, [pasted]),
    ).toBe("Before first\nsecond after");
  });
});
