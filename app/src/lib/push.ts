/**
 * Reminders on his phone (Phase 5; his wish of 30/10): 7:00 for the morning
 * list, 21:00 for the evening list.
 *
 * The server decides everything (the notify function, woken every 5 minutes):
 * an iPhone runs nothing while the app is closed. The phone only
 *   1. asks permission, once, straight from a tap (iOS refuses any other way:
 *      the question must be the very first thing the tap does);
 *   2. hands the server its address for notifications, with the personal key;
 *   3. hands it over again every time the app opens (iOS may change it).
 * On an iPhone this only works from the Home Screen icon, never in Safari.
 */

import { VAPID_PUBLIC_KEY } from './server-config.ts';
import type { Rest } from './sync.ts';

/**
 * on           reminders come
 * off          they can be switched on with a tap
 * denied       refused in the phone's settings (only Instellingen can undo it)
 * browser-tab  an iPhone in Safari: open the app from the Home Screen first
 * unsupported  this browser cannot show notifications
 */
export type PushState = 'on' | 'off' | 'denied' | 'browser-tab' | 'unsupported';

/** Remembers that he switched them on, for the first draw (the real check is async). */
const FLAG = 'studyflow.push';

function remember(on: boolean): void {
  try {
    if (on) localStorage.setItem(FLAG, 'aan');
    else localStorage.removeItem(FLAG);
  } catch {
    // Blocked storage: only the first draw guesses wrong.
  }
}

function wasOn(): boolean {
  try {
    return localStorage.getItem(FLAG) === 'aan';
  } catch {
    return false;
  }
}

function isIos(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** Opened from the Home Screen icon. */
export function standalone(): boolean {
  try {
    return (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;
  } catch {
    return false;
  }
}

function supported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** The state without waiting: good enough to draw the switch at once. */
export function quickState(): PushState {
  if (typeof navigator === 'undefined') return 'unsupported';
  if (isIos() && !standalone()) return 'browser-tab';
  if (!supported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return Notification.permission === 'granted' && wasOn() ? 'on' : 'off';
}

/** The real state: is there an address the server can send to? */
export async function currentState(): Promise<PushState> {
  const quick = quickState();
  if (quick !== 'on' && quick !== 'off') return quick;
  if (Notification.permission !== 'granted') return 'off';
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  return subscription ? 'on' : 'off';
}

/** The VAPID key as the bytes PushManager wants. */
export function keyBytes(base64url: string): Uint8Array {
  const clean = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(clean + '==='.slice((clean.length + 3) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function subscribe(registration: ServiceWorkerRegistration): Promise<PushSubscription> {
  return (
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC_KEY) as BufferSource }))
  );
}

async function hand(rest: Rest, subscription: PushSubscription): Promise<void> {
  const json = subscription.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) throw new Error('Deze telefoon gaf geen volledig adres voor meldingen.');
  await rest.rpc('sf_push_subscribe', { p_endpoint: json.endpoint, p_p256dh: json.keys.p256dh, p_auth: json.keys.auth });
}

/**
 * Switch reminders on. Call it straight from the tap: the permission question
 * comes first, before anything else is awaited.
 */
export async function enablePush(rest: Rest): Promise<PushState> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  const registration = await navigator.serviceWorker.ready;
  await hand(rest, await subscribe(registration));
  remember(true);
  return 'on';
}

/** Switch reminders off: the server forgets the address, the phone too. */
export async function disablePush(rest: Rest): Promise<PushState> {
  remember(false);
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (subscription) {
    await rest.rpc('sf_push_unsubscribe', { p_endpoint: subscription.endpoint }).catch(() => undefined);
    await subscription.unsubscribe().catch(() => false);
  }
  return 'off';
}

/** On every start: hand the (possibly new) address over again. Never asks anything. */
export async function refreshPush(rest: Rest): Promise<void> {
  if (!supported() || Notification.permission !== 'granted' || !wasOn()) return;
  const registration = await navigator.serviceWorker.ready;
  await hand(rest, await subscribe(registration));
}
