/** Convert an observed absolute file inside this workspace to its API path. */
export function workspaceFilePath(root: string, value: string): string {
  const base=root.trim().replace(/\\/g,'/').replace(/\/+$/,'');
  const path=value.trim().replace(/\\/g,'/').replace(/^\.\//,'');
  return base && path.startsWith(`${base}/`) ? path.slice(base.length+1) : path;
}
