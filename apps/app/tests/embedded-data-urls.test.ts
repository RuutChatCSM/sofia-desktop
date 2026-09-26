import { describe, expect, test } from "bun:test";

import {
  EMBEDDED_DATA_PLACEHOLDER,
  EMBEDDED_IMAGE_PLACEHOLDER,
  containsEmbeddedBinary,
  sanitizePromptText,
  stripEmbeddedBinary,
} from "../src/lib/embedded-data-urls";

const IMAGE = `data:image/png;base64,${"iVBORw0KGgoAAAANSUhEUg".repeat(4)}`;
const OCTET = `data:application/octet-stream;base64,${"QUJDREVGRw".repeat(4)}`;

describe("no encoded binary in prompt text", () => {
  test("a pasted image data URL never ships as text", () => {
    const { text, removed } = stripEmbeddedBinary(`look at this ${IMAGE} please`);

    expect(removed).toBe(1);
    expect(text).toContain(EMBEDDED_IMAGE_PLACEHOLDER);
    expect(text).not.toContain("base64");
  });

  test("other encoded blobs are called out with the generic note", () => {
    const { text, removed } = stripEmbeddedBinary(`payload: ${OCTET}`);

    expect(removed).toBe(1);
    expect(text).toContain(EMBEDDED_DATA_PLACEHOLDER);
    expect(text).not.toContain("base64");
  });

  test("leaves short data URIs quoted in code snippets alone", () => {
    const snippet = "const icon = 'data:image/png;base64,iVBORw0KGgo=';";

    expect(containsEmbeddedBinary(snippet)).toBeFalse();
    expect(sanitizePromptText(snippet)).toBe(snippet);
  });

  test("strips every blob and is idempotent", () => {
    const once = sanitizePromptText(`${IMAGE}\nand\n${OCTET}`);

    expect(once).not.toContain("base64");
    expect(sanitizePromptText(once)).toBe(once);
    expect(stripEmbeddedBinary(`${IMAGE}${OCTET}`).removed).toBe(2);
  });
});
