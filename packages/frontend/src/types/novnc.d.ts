declare module '@novnc/novnc/lib/rfb.js' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: Record<string, unknown>);
    scaleViewport: boolean;
    resizeSession: boolean;
    viewOnly: boolean;
    /** CSS background of the area around a scaled display. */
    background: string;
    disconnect(): void;
    focus(options?: FocusOptions): void;
    blur(): void;
    sendCtrlAltDel(): void;
    /** A key event; `down` omitted sends a press and a release. */
    sendKey(keysym: number, code: string | null, down?: boolean): void;
  }
}
