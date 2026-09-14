import { describe, expect, it } from "vitest";
import { PipelineError, summarizeTranscript } from "../src/pipeline/pipeline";
import { DEFAULT_TEMPLATES } from "../src/pipeline/templates";
import { fuseTranscript, UNKNOWN_SPEAKER } from "../src/transcription/fusion";
import { fakeClient, seg, transcript } from "./helpers";

const settings = { shape: "structured" as const, templates: DEFAULT_TEMPLATES };

describe("summarization pipeline", () => {
  it("sends the serialized Transcript inside the structured template", async () => {
    const client = fakeClient();
    await summarizeTranscript(transcript(), settings, client);
    expect(client.prompts).toHaveLength(1);
    const prompt = client.prompts[0]!;
    expect(prompt).toContain("Alice: We should ship the beta next Friday.");
    expect(prompt).toContain("Bob: Agreed. I will own the release checklist.");
    expect(prompt).toContain("## Action items");
    expect(prompt).toContain("same language as the transcript");
    expect(prompt).not.toContain("{{transcript}}");
  });

  it("produces a self-contained artifact: summary + collapsible full transcript", async () => {
    const client = fakeClient({
      reply: () => "## TL;DR\nBeta ships Friday.\n\n## Decisions\n- Ship beta **Friday**",
    });
    const { html } = await summarizeTranscript(transcript(), settings, client);
    expect(html).toContain("<h2>TL;DR</h2>");
    expect(html).toContain("<p>Beta ships Friday.</p>");
    expect(html).toContain("<li>Ship beta <strong>Friday</strong></li>");
    expect(html).toContain("<details>");
    expect(html).toContain("Full captions"); // caption words, so labelled as such
    expect(html).toContain("Open question: do we support Firefox ESR?");
    expect(html).not.toMatch(/src=|href=/); // no external assets
  });

  it("shows speaker names and timings in the collapsible transcript", async () => {
    // What a reader needs to locate and verify a claim: who, and when in the
    // meeting. Timings are offsets from the Meeting start, not wall-clock.
    const start = Date.UTC(2026, 8, 13, 10, 0, 0);
    const fused = fuseTranscript(
      transcript({
        startedAt: start,
        segments: [
          seg("Alice", "we shud chip the beater friday", start + 5_000),
          seg("Bob", "ill own the release check list", start + 65_000),
        ],
      }),
      [
        { text: "We should ship the beta Friday.", startMs: 5_500, endMs: 9_000 },
        { text: "I will own the release checklist.", startMs: 65_500, endMs: 68_000 },
        { text: "Anything else?", startMs: 3_600_000, endMs: 3_602_000 },
      ],
    );
    const { html } = await summarizeTranscript(fused, settings, fakeClient());
    expect(html).toContain(
      '<span class="at">00:05</span> <span class="speaker">Alice:</span> We should ship the beta Friday.',
    );
    expect(html).toContain(
      '<span class="at">01:05</span> <span class="speaker">Bob:</span> I will own the release checklist.',
    );
    // Past the hour the clock grows an hours field, and speech the Speaker Track
    // cannot name is still shown rather than dropped.
    expect(html).toContain(
      `<span class="at">1:00:00</span> <span class="speaker">${UNKNOWN_SPEAKER}:</span> Anything else?`,
    );
  });

  it("gives the Provider real speaker names, so action items get real owners", async () => {
    const start = Date.UTC(2026, 8, 13, 10, 0, 0);
    const fused = fuseTranscript(
      transcript({
        startedAt: start,
        segments: [seg("Bob", "ill own the release check list", start + 10_000)],
      }),
      [
        {
          text: "I will own the release checklist.",
          startMs: 10_500,
          endMs: 14_000,
          diarizationLabel: "Speaker 1",
        },
      ],
    );
    const client = fakeClient();
    await summarizeTranscript(fused, settings, client);
    expect(client.prompts[0]).toContain("Bob: I will own the release checklist.");
    expect(client.prompts[0]).not.toContain("Speaker 1");
  });

  it("escapes HTML from transcript and summary content", async () => {
    const t = transcript({
      title: "<script>alert(1)</script>",
      segments: [{ speaker: "Mallory<b>", text: "use <img> tags", capturedAt: 0 }],
    });
    const client = fakeClient({ reply: () => "TL;DR: beware <script> tags" });
    const { html } = await summarizeTranscript(t, settings, client);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Mallory&lt;b&gt;");
  });

  it("wraps provider failure in PipelineError (the Held Transcript path)", async () => {
    const client = fakeClient({ failWith: new Error("HTTP 529 overloaded") });
    await expect(summarizeTranscript(transcript(), settings, client)).rejects.toThrow(
      PipelineError,
    );
    await expect(summarizeTranscript(transcript(), settings, client)).rejects.toThrow(
      /HTTP 529 overloaded/,
    );
  });

  it("rejects an empty Transcript", async () => {
    await expect(
      summarizeTranscript(transcript({ segments: [] }), settings, fakeClient()),
    ).rejects.toThrow(PipelineError);
  });
});

describe("Summary Artifact provenance", () => {
  const START = Date.UTC(2026, 8, 13, 10, 0, 0);
  const AUDIO_CLAUSE = "from recorded audio";
  const CAPTIONS_CLAUSE = "from live captions only — no audio was recorded";

  const captionBase = () =>
    transcript({
      startedAt: START,
      provenance: "captions-only",
      segments: [seg("Alice", "ill own the release check list", START + 10_000)],
    });

  /** Summary with an Action items heading, as the structured shape produces. */
  const withActionItems = () =>
    fakeClient({ reply: () => "## TL;DR\nBeta ships Friday.\n\n## Action items\n- Bob: release" });

  async function render(t: Parameters<typeof summarizeTranscript>[0]): Promise<string> {
    const { html } = await summarizeTranscript(t, settings, withActionItems());
    return html;
  }

  it("says the words came from audio and the names from captions", async () => {
    const fused = fuseTranscript(captionBase(), [
      { text: "I will own the release checklist.", startMs: 10_500, endMs: 14_000 },
    ]);
    const html = await render(fused);
    expect(html).toContain("from recorded audio, speakers from captions");
    expect(html).not.toContain(CAPTIONS_CLAUSE);
    expect(html).toContain("Full transcript");
    // Owners came from the Speaker Track, so nothing is caveated here.
    expect(html).not.toContain("speaker labels are unverified");
  });

  it("says the speakers are not identified when captions never named anyone", async () => {
    const fused = fuseTranscript(
      captionBase(),
      [{ text: "I will own the release checklist.", startMs: 10_500, endMs: 14_000 }],
      [],
    );
    const html = await render(fused);
    expect(html).toContain("from recorded audio · speakers not identified");
    expect(html).not.toContain(CAPTIONS_CLAUSE);
    // Forgetting captions costs the names, not the Meeting: the audio words are
    // kept under the Unknown speaker marker and the Summary still lands.
    expect(html).toContain(`<span class="speaker">${UNKNOWN_SPEAKER}:</span> I will own`);
    expect(html).toContain("<h2>TL;DR</h2>");
    // The words are audio's, so the section keeps its name.
    expect(html).toContain("Full transcript");
    // And the caveat is repeated where a wrong owner does damage.
    expect(html).toMatch(/Action items.*speaker labels are unverified/s);
  });

  it("says plainly that a Degraded Capture came from captions alone", async () => {
    const html = await render(captionBase());
    expect(html).toContain(CAPTIONS_CLAUSE);
    // Forgetting Capture Start costs accuracy, not the Meeting: the caption words
    // carry the Summary rather than nothing being produced.
    expect(html).toContain("<h2>TL;DR</h2>");
    expect(html).toContain("ill own the release check list");
    // The exact defect this must prevent: a caption-only summary reading as audio.
    expect(html).not.toContain(AUDIO_CLAUSE);
    expect(html).toContain("Full captions");
    expect(html).not.toContain("Full transcript");
  });

  it("reads a Transcript that carries no claim as the weakest case", async () => {
    // A Held Transcript from before provenance existed. Absence of a claim must
    // never be rendered as a claim of recorded audio.
    const html = await render(transcript({ provenance: undefined }));
    expect(html).toContain(CAPTIONS_CLAUSE);
    expect(html).not.toContain(AUDIO_CLAUSE);
    expect(html).toContain("Full captions");
  });
});

describe("Meta line: duration and the opt-in engine clause", () => {
  const START = Date.UTC(2026, 8, 13, 10, 0, 0);
  const engine = { id: "local Whisper", model: "base" };

  const base = () =>
    transcript({
      startedAt: START,
      endedAt: START + 1_845_000, // 30:45
      provenance: "captions-only",
      engine,
      segments: [seg("Alice", "hello", START + 1_000)],
    });

  it("states how long the meeting was", async () => {
    const { html } = await summarizeTranscript(base(), settings, fakeClient());
    expect(html).toContain("30:45");
  });

  it("claims no duration when the Meeting was never seen to end", async () => {
    // Rather than inventing one from render time.
    const { html } = await summarizeTranscript(
      transcript({ startedAt: START, endedAt: undefined, segments: [seg("A", "hi", START)] }),
      settings,
      fakeClient(),
    );
    expect(html).not.toMatch(/· \d+:\d\d ·/);
  });

  it("omits the engine by default, so a forwarded artifact discloses nothing", async () => {
    const { html } = await summarizeTranscript(base(), settings, fakeClient());
    expect(html).not.toContain("local Whisper");
  });

  it("names the engine only once the reader opts in", async () => {
    const { html } = await summarizeTranscript(
      base(),
      { ...settings, nameEngineInArtifact: true },
      fakeClient(),
    );
    expect(html).toContain("local Whisper base");
  });

  it("opting in cannot name an engine the Transcript never recorded", async () => {
    const { html } = await summarizeTranscript(
      transcript({ startedAt: START, endedAt: START + 60_000, engine: undefined }),
      { ...settings, nameEngineInArtifact: true },
      fakeClient(),
    );
    expect(html).not.toContain("undefined");
  });
});
