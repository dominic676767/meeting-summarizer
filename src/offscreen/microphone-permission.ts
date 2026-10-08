export type MicrophonePermissionState = PermissionState | "unknown";

/** Check access without opening a microphone or requesting permission. */
export async function microphonePermission(): Promise<MicrophonePermissionState> {
  try {
    const permission = await navigator.permissions.query({
      name: "microphone" as PermissionName,
    });
    return permission.state;
  } catch {
    // Some browsers do not expose microphone access through the Permissions API.
    return "unknown";
  }
}

/** Call from a visible extension page so Chrome can show its permission prompt. */
export async function requestMicrophonePermission(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  // This step grants access. Meeting capture opens its own stream later.
  for (const track of stream.getTracks()) track.stop();
}
