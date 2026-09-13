// Message protocol between content scripts, background, and popup.
import type { CaptionSnapshot } from "./adapters/adapter";
import type { HeldTranscript } from "./domain/types";

export type ContentMessage =
  | { type: "captions-update"; platform: string; title: string | null; updates: CaptionSnapshot[] }
  | { type: "meeting-status"; platform: string; title: string | null; inMeeting: boolean }
  | { type: "meeting-ended"; platform: string; title: string | null };

export type PopupMessage =
  | { type: "get-status" }
  | { type: "summarize-now" }
  | { type: "list-held" }
  | { type: "retry-held"; id: string };

export type Message = ContentMessage | PopupMessage;

export interface StatusReply {
  inMeeting: boolean;
  segmentCount: number;
  title: string | null;
  /** capturing = in a meeting AND segments have been arriving */
  capturing: boolean;
  state: "idle" | "capturing" | "summarizing" | "done" | "failed";
}

export interface HeldListReply {
  held: HeldTranscript[];
}
