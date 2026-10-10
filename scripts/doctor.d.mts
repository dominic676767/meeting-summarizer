// Types for doctor.mjs, so that tests/doctor.test.ts is type-checked.
export interface CheckResult {
  level: "pass" | "fail" | "warn" | "info";
  text: string;
  fix?: string;
}
type Fetch = (url: string, init?: RequestInit) => Promise<{ ok?: boolean; status: number }>;
export const NODE_FLOOR: number;
export const OLLAMA_URL: string;
export function extensionIdFromKey(key: string): string;
export function checkNode(version?: string): CheckResult;
export function checkBuild(root: string): CheckResult[];
export function checkPlatform(platform?: string, chromeInstalled?: boolean): CheckResult[];
export function checkHuggingFace(fetchImpl?: Fetch): Promise<CheckResult>;
export function checkOllama(extensionId: string, fetchImpl?: Fetch, baseUrl?: string): Promise<CheckResult[]>;
