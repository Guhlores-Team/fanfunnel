// The parts of web-push (server-only; VAPID signing + RFC 8291 payload
// encryption) this app uses. Declared locally rather than adding a types package.
declare module "web-push" {
  export interface PushSubscription {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }
  export interface VapidDetails {
    subject: string;
    publicKey: string;
    privateKey: string;
  }
  export interface RequestOptions {
    vapidDetails?: VapidDetails;
    TTL?: number;
    timeout?: number;
    topic?: string;
    urgency?: "very-low" | "low" | "normal" | "high";
    headers?: Record<string, string>;
  }
  export interface SendResult {
    statusCode: number;
    body: string;
    headers: Record<string, string>;
  }
  export class WebPushError extends Error {
    statusCode: number;
    body: string;
    endpoint: string;
    headers: Record<string, string>;
  }
  export function sendNotification(
    subscription: PushSubscription,
    payload?: string | Buffer | null,
    options?: RequestOptions
  ): Promise<SendResult>;
  export function generateVAPIDKeys(): { publicKey: string; privateKey: string };
  const webpush: {
    sendNotification: typeof sendNotification;
    generateVAPIDKeys: typeof generateVAPIDKeys;
    WebPushError: typeof WebPushError;
  };
  export default webpush;
}
