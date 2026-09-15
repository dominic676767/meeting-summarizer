// Mixing the tab stream and the local microphone into one Audio Recording.
//
// ADR-0004 assumed "tab audio" was the meeting's audio. It is only half of it:
// `chromeMediaSource: "tab"` captures what comes *out* of the tab, i.e. the
// remote participants, and Teams never echoes the local user's own voice back to
// them. So a Meeting where the local user does the talking was recorded silent.
// ADR-0007 records the correction; this module is the fix.
//
// It is deliberately a pure function over an injected graph rather than code that
// reaches for `AudioContext` directly, because the two things that make it
// correct are both graph-shaped and neither is observable from a recording:
//
//   - the tab must reach the speakers, or the user hears silence for the whole
//     call (ADR-0004);
//   - the microphone must NOT reach the speakers, or the user is echoed back to
//     themselves. That is a defect, not a feature, and the only way to catch it
//     without a browser is to be able to look at where each source went.
//
// Time alignment falls out of the shape: both sources are summed into one
// destination inside one graph, so one MediaRecorder sees one clock. Utterance
// offsets are absolute ms from the Meeting start and fusion attributes speech by
// overlapping them against the Speaker Track, so two independently-started
// recorders would drift and silently misattribute speech to the wrong person.

/**
 * The slice of Web Audio the mix needs, generic over whatever a node is, so the
 * real implementation can hand over `AudioNode`s and a test can hand over names.
 */
export interface MixGraph<Node> {
  /** A node carrying one captured stream's audio. */
  source(stream: MediaStream): Node;
  connect(from: Node, to: Node): void;
  /** The user's speakers — what the meeting must keep playing through. */
  readonly speakers: Node;
  /** What the recorder records. */
  readonly recorded: Node;
  /** The mixed stream to hand to the MediaRecorder. */
  readonly recordedStream: MediaStream;
}

/**
 * The streams one Capture Span is made of. The tab is always present; the
 * microphone is absent whenever it is switched off in settings, not yet
 * confirmed, or unavailable — a denied microphone degrades to tab-only capture
 * rather than failing the recording.
 */
export interface CaptureStreams {
  tab: MediaStream;
  mic?: MediaStream;
}

/**
 * Wires the captured streams into one recording and returns the stream to
 * record. Tab audio goes to the speakers as well as to the recording; the
 * microphone goes only to the recording.
 */
export function mixCapture<Node>(graph: MixGraph<Node>, streams: CaptureStreams): MediaStream {
  const tab = graph.source(streams.tab);
  // tabCapture stops playing the tab's audio to the user, so this connection is
  // what keeps the meeting audible for its whole duration (ADR-0004).
  graph.connect(tab, graph.speakers);
  graph.connect(tab, graph.recorded);
  if (streams.mic) {
    // Recorded, never played. Connecting this to the speakers would echo the
    // user to themselves through their own headphones.
    graph.connect(graph.source(streams.mic), graph.recorded);
  }
  return graph.recordedStream;
}
