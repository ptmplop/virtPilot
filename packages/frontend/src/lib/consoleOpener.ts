import { toast } from 'sonner';

// 1200×760 lands at roughly 150 cols × 48 rows for the default xterm font. The
// previous 960×600 squashed the header (tab switcher + connection state + VM
// action buttons + theme picker fit but visibly cramped). 1200 leaves the
// header airy without losing the "popup, not a full browser window" feel.
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

/**
 * Open the VM console (Console / SSH / VNC tabs) for a VM, either as a popup
 * or via in-app navigation depending on user preference. If a popup is
 * requested but blocked by the browser, we fall back to in-app navigation and
 * toast a hint so the user can either allow popups or flip the preference off.
 *
 * The window name `vp-console-${uuid}` is the browser's hint to *reuse* the
 * existing popup for the same VM instead of spawning a duplicate — re-clicking
 * navigates the existing window. `w.focus()` brings it to front on most
 * browsers, but isn't a guarantee (Firefox in particular often ignores focus
 * calls when the popup was opened from a separate tab; the user may need to
 * alt-tab).
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

  const w = window.open(url, `vp-console-${uuid}`, POPUP_FEATURES);
  if (!w) {
    toast.error('Popup blocked — opening in this tab. Allow popups for this site, or turn off popup mode on the VMs page.');
    navigate(url);
    return;
  }
  w.focus();
}
