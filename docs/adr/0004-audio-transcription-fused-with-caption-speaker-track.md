# Audio transcription fused with a caption Speaker Track

Transcript words now come from transcribing recorded tab audio, not from scraped captions. Captions are kept — but only as the **Speaker Track** (who spoke when), because transcription engines return anonymous diarization ("Speaker 1") while action items need real owners. The two are fused by overlapping time ranges: accurate words from audio, real names from captions.

This fixes both accuracy complaints at once: audio gives ground-truth words (captions had wrong words), and a continuous recording cannot miss a line the caption panel scrolled past (captions dropped lines).

## Consequences

- **The captured stream must be looped back to the speakers.** `tabCapture` stops playing the tab's audio to the user; the recorder has to reconnect the stream to an `AudioContext` destination or the user hears silence for the whole meeting.
- **Recording lives in an offscreen document** with reason `USER_MEDIA` — MV3 service workers have no DOM. Not `AUDIO_PLAYBACK`, which self-closes after 30s without playback and would kill long recordings.
- **Audio is encoded incrementally to browser-managed storage**, never accumulated whole in memory: an hour of audio in RAM contradicts the lightweightness requirement.
- **Two provider abstractions now exist**, and conflating them is a mistake: a Transcription Provider (audio → Utterances) and a Provider (Transcript → Summary). Most LLM backends offer no speech-to-text, so the sets do not overlap — Claude and Bedrock-as-configured cannot transcribe.
- **Local WASM Whisper is the default** Transcription Provider so a public user with no API key and no willingness to upload meeting audio still gets accurate transcripts. Cloud engines are opt-in and slower to trust, faster to run.
- Captions remain a hard dependency for attribution, so "turn captions on" stays in the setup instructions and the no-captions warning stays in the popup.

## Considered Options

- **Diarization labels only, no caption fusion** — rejected: loses owner names, gutting the action-items section that is the point of the structured summary.
- **Live streaming transcription during the meeting** — deferred: heavier and more moving parts. Batch transcription at Meeting End matches the existing post-meeting model; streaming is a later optimization.
- **Mic-only capture via `getUserMedia`** — rejected: captures only the local user, not the meeting.
