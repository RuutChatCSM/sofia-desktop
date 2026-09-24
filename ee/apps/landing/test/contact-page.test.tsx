import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AppFeedbackForm } from "../components/app-feedback-form";
import { SiteFooter } from "../components/site-footer";

const contactPrefill = {
  source: "sofia-contact-page",
  entrypoint: "/contact",
  deployment: "landing",
  appVersion: "",
  sofiaServerVersion: "",
  engineVersion: "",
  osName: "",
  osVersion: "",
  platform: "web",
};

describe("Contact page affordances", () => {
  test("renders contact-oriented copy and the direct team email", () => {
    const html = renderToStaticMarkup(createElement(AppFeedbackForm, {
      prefill: contactPrefill,
      mode: "contact",
    }));

    expect(html).toContain("Have questions about Sofia?");
    expect(html).toContain("Prefer to email us instead?");
    expect(html).toContain("team@ruut.chat");
    expect(html).toContain("Send question");
  });

  test("footer links to the contact page", () => {
    const html = renderToStaticMarkup(createElement(SiteFooter));

    expect(html).toContain('href="/contact"');
    expect(html).toContain("Contact");
  });
});
