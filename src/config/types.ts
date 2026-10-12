export type Mode = "off" | "summary" | "cpu" | "trace";
export type Variant = "upstream" | "clean-control" | "candidate";
export interface SourceRequest { repository: string; refPolicy: "remote-default-head" | "explicit-remote-ref"; ref?: string }
export interface SourceReceipt { repository: string; sourceKind: "github-baseline" | "local-candidate"; remoteRef: string; sha: string; baseSha?: string; fetchedAt: string; checkoutPath: string }
export interface PackageReceipt { repository: string; ownerSha: string; extensionId: string; sourcePath: string; packageHash: string; destinationPaths: string[] }
export interface SourceManifest { experimentId: string; sources: SourceReceipt[]; packages: PackageReceipt[]; runtime: Record<string, {path: string; version: string; hash: string}> }
export interface PreparedVariant { variant: Variant; root: string; manifest: SourceManifest }
export interface Scenario { id: string; project: "Java"; cwd: string; executable: string; args: string[]; courseProfile: "student" | "full"; cachePolicy: "clean-output" | "repeat-render"; mode: Mode; scope: {modules: string[]; extensions: string[]; strict: boolean}; resources: {wall: boolean; cpu: boolean; peakRss: boolean} }
export interface PreparationReceipt { kind: "bootstrap" | "ts-transform" | "quarto-adapter"; path: string; sourceHash: string; preparedHash: string; sourceMapPath?: string }
export interface RunResult { runId: string; buildExitCode: number; dataValid: boolean; outputDirectory: string; preparation: PreparationReceipt[]; wallSeconds: number; signal: string | null }
