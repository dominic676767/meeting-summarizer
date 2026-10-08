import { ext } from "../platform";
import type { OffscreenMessage, OffscreenMicPermissionReply } from "../messages";
import type { MicrophonePermissionState } from "../offscreen/microphone-permission";

/**
 * Check the recorder's access before obtaining the short-lived tab stream ID.
 * The offscreen document must exist before calling this function.
 */
export async function prepareMicrophoneAccess(): Promise<MicrophonePermissionState> {
  const reply = (await ext.runtime.sendMessage({
    type: "offscreen-mic-permission",
  } satisfies OffscreenMessage)) as OffscreenMicPermissionReply;
  const permission = reply.permission;
  if (permission !== "prompt" && permission !== "denied") return permission;

  const optionsUrl = ext.runtime.getURL("options.html");
  const tabs = await ext.tabs.query({ url: `${optionsUrl}*` });
  const existing = tabs.find((tab) => tab.id !== undefined);
  if (existing?.id !== undefined) {
    await ext.tabs.update(existing.id, { url: `${optionsUrl}#microphone`, active: true });
    if (existing.windowId !== undefined) {
      await ext.windows.update(existing.windowId, { focused: true });
    }
  } else {
    await ext.tabs.create({ url: `${optionsUrl}#microphone` });
  }
  return permission;
}
