// Pure pieces of the shared serial console (console.ts): the output backlog a late
// joiner is replayed, the filter that drops virsh's own banner, the words for why a
// console ended, and the input filter. Kept apart from the pty and socket wiring so
// they can be tested.

/**
 * The most recent console output, measured in bytes from the start of the session.
 * `total` counts every byte ever appended, so a viewer that remembers how far it had
 * read can be sent exactly what it missed while it was away.
 */
export class Backlog {
  private chunks: Buffer[] = [];
  private bytes = 0;
  /** Bytes appended since the session began. */
  total = 0;

  constructor(private readonly cap: number) {}

  /** The offset of the oldest byte still held. */
  get start(): number {
    return this.total - this.bytes;
  }

  append(buf: Buffer): void {
    if (buf.length === 0) return;
    this.chunks.push(buf);
    this.bytes += buf.length;
    this.total += buf.length;
    while (this.bytes > this.cap && this.chunks.length > 0) {
      const head = this.chunks[0];
      const over = this.bytes - this.cap;
      if (head.length <= over) {
        this.chunks.shift();
        this.bytes -= head.length;
      } else {
        this.chunks[0] = head.subarray(over);
        this.bytes -= over;
      }
    }
  }

  /** Everything from `offset` on, or null when the backlog no longer reaches back that far. */
  since(offset: number): Buffer | null {
    if (!Number.isInteger(offset) || offset < this.start || offset > this.total) return null;
    return Buffer.concat(this.chunks).subarray(offset - this.start);
  }

  /**
   * What a new viewer is shown: the whole backlog, starting at a line once older output
   * has been dropped (a cut can land inside an escape sequence or a character). `from`
   * is the offset of its first byte.
   */
  replay(): { from: number; data: Buffer } {
    const data = Buffer.concat(this.chunks);
    if (this.start === 0) return { from: 0, data };
    const nl = data.subarray(0, 4096).indexOf(0x0a);
    const skip = nl === -1 ? 0 : nl + 1;
    return { from: this.start + skip, data: data.subarray(skip) };
  }
}

const BANNER = /^Connected to domain [^\r\n]*\r?\nEscape character is [^\r\n]*\r?\n/;
const BANNER_LINES = ['Connected to domain ', 'Escape character is '];

// True while `head` could still turn out to be virsh's two-line banner.
function couldBeBanner(head: string): boolean {
  const lines = head.split('\n');
  if (lines.length > 2 && lines[2] !== '') return false;
  return lines.slice(0, 2).every((line, i) => {
    const word = BANNER_LINES[i];
    return word.startsWith(line) || line.startsWith(word);
  });
}

export interface BannerFilter {
  /** Output to pass on for this chunk (empty while it may still be the banner). */
  push(chunk: string): string;
  /** Gives up waiting: returns whatever was held back. */
  flush(): string;
}

/**
 * `virsh console` opens with "Connected to domain 'x'" and "Escape character is ^]".
 * The escape character never reaches virsh from here (stripInput), so the banner would
 * only mislead; it is dropped from the start of the session and anything else passes
 * through untouched.
 */
export function createBannerFilter(): BannerFilter {
  let head: string | null = '';
  return {
    push(chunk) {
      if (head === null) return chunk;
      head += chunk;
      const match = BANNER.exec(head);
      if (match) {
        const rest = head.slice(match[0].length);
        head = null;
        return rest;
      }
      if (head.length > 512 || !couldBeBanner(head)) {
        const out = head;
        head = null;
        return out;
      }
      return '';
    },
    flush() {
      if (head === null) return '';
      const out = head;
      head = null;
      return out;
    },
  };
}

// WebSocket close reasons are capped at 123 bytes.
function capReason(text: string): string {
  let out = text;
  while (Buffer.byteLength(out) > 120) out = out.slice(0, -1);
  return out;
}

/** Close code for "the VM is not running": the browser shows Power on, not Reconnect. */
export const CLOSE_VM_DOWN = 4001;

/**
 * Why `virsh console` ended, in words for the console's bar, from its exit code and the
 * last of its output, and whether that means the VM is down. Measured on libvirt 11: a
 * domain that is not running prints "error: The domain is not running" and exits 1; a
 * second `virsh console --force` makes the first print "error: stream had I/O failure"
 * and exit 1; a domain that stops while attached ends it with exit 0.
 */
export function consoleExit(exitCode: number, tail: string): { reason: string; vmDown: boolean } {
  // Exit 0 is the console ending with the domain. The tail is mostly the guest's own
  // output, which has "error:" lines of its own ("EXT4-fs error: …"), so it is only read
  // for a failure, and only virsh's own lines, which start with "error: ".
  if (exitCode === 0) return { reason: 'The VM stopped', vmDown: true };
  const errors = [...tail.matchAll(/(?:^|\n)error: ([^\r\n]+)/g)];
  const last = errors.length > 0 ? errors[errors.length - 1][1].trim() : null;
  if (last) {
    if (/stream had I\/O failure/i.test(last)) return { reason: 'Another console session took over', vmDown: false };
    if (/domain is not running/i.test(last)) return { reason: 'The VM is not running', vmDown: true };
    if (/failed to get domain|domain not found/i.test(last)) return { reason: 'The VM no longer exists', vmDown: false };
    const sentence = last.replace(/\.$/, '');
    return { reason: capReason(sentence.charAt(0).toUpperCase() + sentence.slice(1)), vmDown: false };
  }
  return { reason: 'The console closed', vmDown: false };
}

/**
 * Keystrokes for the guest. Ctrl+] (0x1d) is virsh's escape character: it would detach
 * the console for every viewer sharing it, and it never reached the guest anyway.
 */
export function stripInput(data: Buffer): Buffer {
  return data.includes(0x1d) ? Buffer.from(data.filter((b) => b !== 0x1d)) : data;
}
