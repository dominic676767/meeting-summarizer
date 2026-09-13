// The Provider abstraction: the user-selected LLM backend that turns a
// Transcript into a Summary. Implementations are plain HTTPS via fetch.

export interface ProviderClient {
  readonly name: string;
  /**
   * Approximate input budget in characters (~4 chars/token). The pipeline
   * switches to map-reduce chunking when a prompt would exceed this.
   */
  readonly contextBudget: number;
  complete(prompt: string): Promise<string>;
}

export type FetchFn = typeof fetch;

export class ProviderError extends Error {
  constructor(provider: string, detail: string) {
    super(`${provider}: ${detail}`);
    this.name = "ProviderError";
  }
}

export async function expectOk(provider: string, res: Response): Promise<void> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ProviderError(provider, `HTTP ${res.status} ${body.slice(0, 300)}`);
  }
}
