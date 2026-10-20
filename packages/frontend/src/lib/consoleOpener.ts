import { toast } from 'sonner';

// 1200×760 lands at roughly 150 cols × 44 rows: room for the header and tab strip
// without losing the "a console window, not a browser" feel.
const POPUP_WIDTH = 1200;
const POPUP_HEIGHT = 760;

// `popup=yes` is the only signal modern browsers actually look at; the legacy
// flags are kept for older browsers and for clarity. With these, Chrome /
// Edge / Firefox strip tabs and the bookmarks bar and Safari opens a
// borderless window.
const POPUP_FEATURES = [
  'popup=yes',
  `width=${POPUP_WIDTH}`,
  `height=${POPUP_HEIGHT}`,
  'resizable=yes',
  'scrollbars=no',
  'toolbar=no',
  'location=no',
  'menubar=no',
  'status=no',
].join(',');

// One console window per dashboard tab: every VM's console opens as a tab inside it.
const CONSOLE_WINDOW = 'virtpilot-console';

/** The fragment a console window reads as "open a tab for this VM". */
export const CONSOLE_OPEN_HASH = 'open';

const CONSOLE_PATH = /^\/vms\/[^/]+\/console$/;

/**
 * Open a VM's console, in the console window or in this tab, as the user prefers. A
 * blocked popup falls back to this tab with a hint.
 *
 * The console window is found by name with an EMPTY url: that hands back an existing
 * window untouched (or opens a fresh about:blank one). Passing the url would navigate an
 * existing window to it, which is a reload: every tab in it would close and every session
 * end. A window already showing consoles is asked for the VM through its address's
 * fragment instead, which it answers by opening a tab (or bringing the VM's tab forward).
 */
export function openVmConsole(
  uuid: string,
  openInPopup: boolean,
  navigate: (path: string) => void,
): void {
  const url = `/vms/${uuid}/console`;
  if (!openInPopup) {
    navigate(url);
    return;
  }

  const w = window.open('', CONSOLE_WINDOW, POPUP_FEATURES);
  if (!w) {
    toast.error('Popup blocked - opening in this tab. Allow popups for this site, or turn off popup mode on the VMs page.');
    navigate(url);
    return;
  }
  try {
    if (CONSOLE_PATH.test(w.location.pathname)) {
      // The time makes each request a new fragment, so the window hears it even when it
      // is the same VM as last time.
      w.location.replace(`${w.location.pathname}${w.location.search}#${CONSOLE_OPEN_HASH}=${uuid}.${Date.now()}`);
    } else {
      w.location.href = url;
    }
  } catch {
    // The window is showing another origin (a sign-in page, say): leave it and bring it forward.
  }
  w.focus();
}
