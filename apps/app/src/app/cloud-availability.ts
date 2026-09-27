/** Hosted Sofia Cloud is available by default. Set VITE_SOFIA_CLOUD_AVAILABLE=0
 * only for distributions that intentionally omit the hosted control plane. */
const setting = String(import.meta.env?.VITE_SOFIA_CLOUD_AVAILABLE ?? "1").trim();
export const SOFIA_CLOUD_AVAILABLE = !/^(0|false|no|off)$/i.test(setting);
