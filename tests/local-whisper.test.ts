import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalWhisperEngine } from "../src/transcription/local-whisper";
import type { EngineSpan } from "../src/transcription/provider";
import type {
  WhisperRequest,
  WhisperResponse,
} from "../src/transcription/whisper-protocol";

class TestWorker {
  static latest: TestWorker;
  listeners: Array<(event: { data: WhisperResponse }) => void> = [];
  requests: WhisperRequest[] = [];
  terminate = vi.fn();

  constructor() {
    TestWorker.latest = this;
  }

  addEventListener(
    type: string,
    listener: (event: { data: WhisperResponse }) => void,
  ): void {
    if (type === "message") this.listeners.push(listener);
  }

  postMessage(message: WhisperRequest): void {
    this.requests.push(message);
    if (message.type === "load") {
      queueMicrotask(() => this.emit({ type: "loaded" }));
    }
  }

  emit(message: WhisperResponse): void {
    for (const listener of this.listeners) listener({ data: message });
  }
}

beforeEach(() => {
  vi.stubGlobal("Worker", TestWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function transcribe(spans: EngineSpan[]): Promise<EngineSpan[]> {
  const engine = createLocalWhisperEngine({
    model: "base",
    language: "en",
    workerUrl: "chrome-extension://test/whisper-worker.js",
  });
  await engine.load();
  const result = engine.transcribe(new Float32Array(160));
  const request = TestWorker.latest.requests.find(
    (message) => message.type === "transcribe",
  );
  if (!request || request.type !== "transcribe") {
    throw new Error("Whisper transcription request was not sent.");
  }
  TestWorker.latest.emit({ type: "spans", id: request.id, spans });
  const output = await result;
  await engine.close?.();
  return output;
}

describe("local Whisper transcript filtering", () => {
  it("omits known silence artifacts and retains real speech metadata", async () => {
    const speech: EngineSpan = {
      text: "We should ship the beta next Friday.",
      startSec: 10,
      endSec: 13,
      speaker: "Dominic",
    };

    expect(
      await transcribe([
        { text: "you you you you you you", startSec: 0, endSec: 4 },
        { text: "Thank you for watching.", startSec: 4, endSec: 7 },
        { text: "[Music]", startSec: 7, endSec: 8 },
        { text: " ", startSec: 8, endSec: 9 },
        speech,
      ]),
    ).toEqual([speech]);
  });

  it("preserves words in a segment that contains real meeting speech", async () => {
    const speech: EngineSpan = {
      text: "you We should ship the beta next Friday. you you you",
      startSec: 0,
      endSec: 9,
    };

    expect(await transcribe([speech])).toEqual([speech]);
  });

  it("returns no speech for a chunk containing only silence artifacts", async () => {
    expect(
      await transcribe([
        { text: "you you you", startSec: 0, endSec: 5 },
        { text: "Thanks. Thanks.", startSec: 5, endSec: 9 },
      ]),
    ).toEqual([]);
  });
});
