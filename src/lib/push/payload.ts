// What a push notification carries. Pure and isomorphic: the item comes from
// the F8 builder (toNotificationItem in src/lib/data/notificationFeed.ts), so
// in detailed mode the title and body are exactly the bell's.
//
// Privacy: the payload is the minimum the service worker needs. Generic mode
// (the D9 default) has no fan or prize names at all; neither mode carries a
// fan link token, a reward code, a spend amount or any URL with a secret: the
// URL is a dashboard section only.
import type { FeedItem, NotificationTarget } from "@/lib/data/notificationFeed";
import { GENERIC_BODY, GENERIC_TITLE, TEST_BODY, TEST_TITLE } from "./config";

export interface PushPayload {
  title: string;
  body: string;
  /** Same-origin dashboard path the tap opens (`/dashboard?section=…`). */
  url: string;
  /** Notification tag: a later push with the same tag replaces it in place. */
  tag: string;
}

export const sectionUrl = (section: NotificationTarget["section"] | "settings") =>
  `/dashboard?section=${section}`;

export function toPushPayload(item: FeedItem, showDetails: boolean): PushPayload {
  const url = sectionUrl(item.target.section);
  if (!showDetails) return { title: GENERIC_TITLE, body: GENERIC_BODY, url, tag: item.id };
  return { title: item.title, body: item.body, url, tag: item.id };
}

export function testPushPayload(): PushPayload {
  return { title: TEST_TITLE, body: TEST_BODY, url: sectionUrl("settings"), tag: "test" };
}
