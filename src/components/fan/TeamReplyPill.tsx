import { LEGAL } from "@/lib/legal";
import type { ChatMessage } from "@/lib/data/types";

/**
 * TS-07: a small "Team" pill on a creator reply a team member wrote, in the
 * fan's chat. Off unless LEGAL.teamReplyLabel.enabled (the owner's switch).
 * `fromTeam` is worked out on the server; the fan never receives who wrote it.
 */
export default function TeamReplyPill({ message }: { message: Pick<ChatMessage, "sender" | "fromTeam"> }) {
  if (message.sender !== "creator" || message.fromTeam !== true || !LEGAL.teamReplyLabel.enabled) return null;
  return (
    <span
      data-testid="team-reply-pill"
      className="mt-0.5 inline-block rounded-full border border-line px-2 py-0.5 text-[10px] font-semibold text-muted"
    >
      {LEGAL.teamReplyLabel.label}
    </span>
  );
}
