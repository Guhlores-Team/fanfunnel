// Client helpers shared by the win-back card and its queue (RM-5).
import { fillTemplate } from "@/lib/winback/template";
import type { OutreachAction } from "@/lib/winback/config";

export interface WinbackFan {
  fanId: string;
  name: string;
  totalSpent: number;
  daysSince: number | null;
  primaryToken: string | null;
  lastWin: string | null;
}

export interface WinbackTemplate {
  id: string;
  title: string;
  body: string;
}

/** The message for one fan: the creator's template, filled in their browser. */
export function winbackMessage(fan: WinbackFan, template: WinbackTemplate, origin: string, creator: string | null): string {
  return fillTemplate(template.body, {
    name: fan.name,
    link: fan.primaryToken ? `${origin}/spin/${fan.primaryToken}` : null,
    lastWin: fan.lastWin,
    days: fan.daysSince,
    creator,
  });
}

/** Log a contact or a snooze. Resolves false on any failure (the caller says so). */
export async function postOutreach(fanId: string, action: OutreachAction, templateId: string | null): Promise<boolean> {
  try {
    const res = await fetch("/api/crm/outreach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fanId, action, templateId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
