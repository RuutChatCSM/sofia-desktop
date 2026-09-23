/**
 * Sofia cloud (the hosted organization control plane) has not shipped yet.
 *
 * Every hosted-cloud entry point stays dark until cloud is available. Self-hosted
 * servers, remote workers, and organization-server sign-in are unaffected: those
 * are the OSS surfaces and keep working today.
 *
 * When cloud ships, flip the default here or build with
 * `VITE_SOFIA_CLOUD_AVAILABLE=1`.
 */
const HOSTED_CLOUD_ENV_KEY = "VITE_SOFIA_CLOUD_AVAILABLE";

export const SOFIA_CLOUD_AVAILABLE = /^(1|true|yes|on)$/i.test(
  String(import.meta.env?.[HOSTED_CLOUD_ENV_KEY] ?? "").trim(),
);
