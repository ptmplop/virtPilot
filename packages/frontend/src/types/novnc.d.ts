declare module '@novnc/novnc/lib/rfb.js' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: Record<string, unknown>);
    scaleViewport: boolean;
    resizeSession: boolean;
    viewOnly: boolean;
    disconnect(): void;
  }
}
