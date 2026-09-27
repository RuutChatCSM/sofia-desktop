# Deferred Sofia Cloud integration

Revisit after the initial `sofia-cloud` migration. For each area, either implement the Rails API contract used by Sofia App or remove the obsolete EE-dependent app flow. Do not present an unsupported flow as available.

- [ ] **Cloud instances:** Audit `getCloudInstance` and `updateCloudInstance` callers. Add Rails equivalents with the expected status and update semantics, or remove the instance UI and API client methods if Cloud will no longer provision per-user instances.
- [ ] **Worker tokens:** Audit `listWorkers` and `getWorkerTokens` callers. Define how Rails remote workers map to desktop workers and issue scoped tokens safely, or remove the old worker connection flow if it no longer applies.
- [ ] **Automations:** Audit the desktop automation API and Cloud placement flow. Implement scheduling, runs, runner presence, and management in Rails where needed, or remove Cloud-only automation options until supported.

Before closing these items, add `evals/specs/**/*.test.ts` coverage for the chosen behavior and verify the relevant desktop and Rails tests.
