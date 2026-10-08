// The Platform Adapter boundary (ADR-0002): per-platform DOM knowledge lives
// here and nowhere else. Exactly two responsibilities: extract Caption
// Segments from the live DOM, and detect Meeting End.

/** One caption entry as currently rendered, with a key stable across in-place mutations. */
export interface CaptionSnapshot {
  key: string;
  speaker: string;
  text: string;
}

export interface PlatformAdapter {
  readonly platform: string;
  /** How long missing call controls may be transient before Meeting End (default 10 seconds). */
  readonly leaveGraceMs?: number;
  /** Snapshot of all caption entries currently in the DOM. */
  readCaptions(root: ParentNode): CaptionSnapshot[];
  /** True while an active call surface is present. */
  isInMeeting(root: ParentNode): boolean;
  /** True when the platform's call-ended state is showing. */
  isMeetingEnded(root: ParentNode): boolean;
  /** Meeting title, or null when the platform offers none (caller falls back to platform name). */
  meetingTitle(doc: Document): string | null;
}
