export type PathEnv = Record<string, string | undefined>;

export interface PathOptions {
  env?: PathEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  userDataDir?: string;
}

export declare const MAX_CONFIG_ROOT_LENGTH: 4096;

export declare function normalizeWorkspaceRootPath(value: unknown, opts?: PathOptions): string;
export declare function sofiaServerConfigDir(opts?: PathOptions): string;
export declare function sofiaServerConfigPath(opts?: PathOptions): string;
export declare function sofiaEnvStorePath(opts?: PathOptions): string;
export declare function globalWorkspaceEngineConfigDir(opts?: PathOptions): string;
export declare function resolveGlobalWorkspaceEngineConfigPath(opts?: PathOptions): string;
export declare function workspaceWorkspaceEngineConfigCandidates(workspaceRoot: string): string[];
export declare function resolveWorkspaceWorkspaceEngineConfigPath(workspaceRoot: string): string;
export declare function sofiaConfigDir(opts?: PathOptions): string;
export declare function sofiaEngineConfigPath(opts?: PathOptions): string;
export declare function desktopBootstrapPath(opts?: PathOptions): string;
export declare function legacyDesktopBootstrapPath(opts?: PathOptions): string;
export declare function expandHomePath(value: string, opts?: PathOptions): string;
export declare function sofiaServerDataDir(opts?: PathOptions): string;
export declare function engineDataDirs(opts?: PathOptions): string[];
export declare function engineCacheDirs(opts?: PathOptions): string[];
