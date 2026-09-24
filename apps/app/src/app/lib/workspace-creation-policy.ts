import { isSofiaGatewayRuntime } from "./gateway-runtime";

export function canCreateWorkspaces() {
  return !isSofiaGatewayRuntime();
}
