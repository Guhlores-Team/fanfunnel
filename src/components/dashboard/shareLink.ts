import { copyToClipboard } from "@/lib/hooks/useClipboard";

export type ShareOutcome = "shared" | "cancelled" | "copied" | "failed";
export interface ShareEnv {
  share?: (data: ShareData) => Promise<void>;
  canShare?: (data: ShareData) => boolean;
  copy: (text: string) => Promise<boolean>;
}

function browserShareEnv(): ShareEnv {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  return {
    share: typeof nav?.share === "function" ? nav.share.bind(nav) : undefined,
    canShare: typeof nav?.canShare === "function" ? nav.canShare.bind(nav) : undefined,
    copy: copyToClipboard,
  };
}

/**
 * Web Share where the browser has it (phones), else copy to the clipboard.
 * A creator closing the share sheet is not an error and copies nothing.
 */
export async function shareOrCopy(data: { title: string; text: string; url: string }, env: ShareEnv = browserShareEnv()): Promise<ShareOutcome> {
  if (env.share && (!env.canShare || env.canShare(data))) {
    try {
      await env.share(data);
      return "shared";
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return "cancelled";
      // NotAllowedError etc.: fall through to copying.
    }
  }
  return (await env.copy(data.url)) ? "copied" : "failed";
}
