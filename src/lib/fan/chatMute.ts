// TS-17: the words for a fan muting a creator's messages, shared by the fan's
// Safety menu and every creator composer that can be refused (the Inbox, the
// fan drawer and the agency seat workspace), so they never drift apart.

/** What a creator sees when a send is refused because the fan muted them (409 muted). */
export const CREATOR_MUTED_MESSAGE = "This fan has muted messages from you. They can still play.";

/** The small note on a muted fan in the creator's fan drawer. */
export const CREATOR_MUTED_NOTE = "Muted messages";

/** The Safety menu item's label for the fan. */
export function muteMenuLabel(creator: string, muted: boolean): string {
  return muted ? "Unmute messages" : `Mute messages from ${creator}`;
}

/** The plain line under the Safety menu item. */
export function muteMenuExplanation(creator: string, muted: boolean): string {
  return muted
    ? `Messages from ${creator} are muted. Unmute to get new ones again.`
    : `You won't get new messages from ${creator}. You can still play and message them.`;
}

/** The confirmation once the change is saved. */
export function muteDoneMessage(creator: string, muted: boolean): string {
  return muted
    ? `Muted. You won't get new messages from ${creator}. You can unmute from this menu at any time.`
    : `Unmuted. New messages from ${creator} will reach you again.`;
}

/** The fan-side message for a failed mute or unmute, by the route's answer. */
export function muteErrorMessage(status: number | "network", serverMessage?: string): string {
  if (status === "network") return "Couldn't save that. Check your connection and try again.";
  if (status === 403 && serverMessage) return serverMessage;
  if (status === 404) return "This link isn't active right now, so nothing changed.";
  if (status === 429) return "Too many tries from your network right now. Try again in a minute.";
  return "Couldn't save that. Try again.";
}
