/**
 * Browser notifications for work that outlives the reader's attention. A local
 * video is minutes of GPU time and an agent turn that draws three pictures is not
 * much less, so the tab that started the work is usually not the one in front of
 * them when it lands.
 *
 * Two calls rather than one, because the permission prompt and the notification
 * want different moments: asking belongs to a click, and telling belongs to the
 * end of the work.
 */

/** One tag for all of it: a second notification replaces the first rather than stacking. */
const TAG = "luma-progress";

/**
 * Asked for where the reader just committed to a wait. A permission prompt raised
 * from a background callback is either dropped by the browser for having no
 * gesture behind it, or read as a nuisance and denied once — and a denial is
 * permanent, so the first ask is the only one there will ever be.
 */
export function askToNotify() {
  if (typeof Notification === "undefined" || Notification.permission !== "default") return;
  void Notification.requestPermission().catch(() => undefined);
}

/**
 * Only while the page is hidden. Notifying someone about something they are
 * already watching finish is how an application teaches people to turn its
 * notifications off.
 */
export function notifyFinished(title: string, body: string) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (document.visibilityState === "visible") return;
  try {
    new Notification(title, { body, tag: TAG });
  } catch {
    // Some engines only permit this from a service worker. The queue and the
    // transcript both still show the result, so there is nothing to report.
  }
}
