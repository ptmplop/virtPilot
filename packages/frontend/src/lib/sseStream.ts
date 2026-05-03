// Replacement for `new EventSource(url)` that supports custom HTTP headers.
// EventSource's API doesn't allow a Bearer token in the Authorization header,
// which would force us to put the JWT in the URL — and that leaks it into
// nginx access logs and journalctl. fetch + ReadableStream gives us the same
// streaming semantics with header support.

export interface SseEvent { type: string; text: string }

export interface StreamHandle { close: () => void }

export function streamSse(
  url: string,
  token: string,
  onEvent: (e: SseEvent) => void,
  onError: () => void,
): StreamHandle {
  const ctrl = new AbortController();
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    ctrl.abort();
  };

  void (async () => {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) { onError(); return; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        // SSE messages are separated by a blank line. Process complete frames.
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLines = frame
            .split('\n')
            .filter((l) => l.startsWith('data: '))
            .map((l) => l.slice(6));
          if (dataLines.length === 0) continue;
          try {
            const payload = JSON.parse(dataLines.join('\n')) as SseEvent;
            onEvent(payload);
          } catch {
            // Non-JSON SSE frame — ignore.
          }
        }
      }
    } catch {
      if (!closed) onError();
    }
  })();

  return { close };
}
