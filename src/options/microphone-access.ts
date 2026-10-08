import { ext } from "../platform";
import { requestMicrophonePermission } from "../offscreen/microphone-permission";

function isUnsupportedView(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  const detail = error instanceof Error ? error.message : String(error);
  return name === "NotSupportedError" || detail.trim().toLowerCase() === "not supported";
}

async function openSettingsTab(): Promise<string> {
  await ext.tabs.create({
    url: `${ext.runtime.getURL("options.html")}#microphone`,
  });
  return "Settings is open in a separate tab. Select Allow microphone access there.";
}

/** Chrome's embedded options view can reject a microphone permission request. */
export async function allowMicrophoneAccess(): Promise<string> {
  if (window.self !== window.top) return openSettingsTab();
  try {
    await requestMicrophonePermission();
  } catch (error) {
    // Chrome can embed options in a guest view that appears to be top-level.
    if (isUnsupportedView(error)) return openSettingsTab();
    throw error;
  }
  return "Microphone access is allowed. Return to the meeting and start recording.";
}

export function microphoneAccessFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  const detail = error instanceof Error ? error.message : String(error);
  if (isUnsupportedView(error)) {
    return "Chrome cannot request microphone access in this Settings view. Open Settings in a separate tab, then try again.";
  }
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone access was blocked. Allow access for this extension in Chrome and allow Chrome to use the microphone in your system settings, then try again.";
  }
  if (name === "NotFoundError") {
    return "No microphone was found. Connect a microphone, then try again.";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return "Chrome could not open the microphone. Check the selected input device and close other apps that use it, then try again.";
  }
  return `Chrome could not request microphone access: ${detail}. Try again from Settings in a separate tab.`;
}
