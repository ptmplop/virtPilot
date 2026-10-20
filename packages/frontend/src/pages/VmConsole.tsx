import { useEffect, useLayoutEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ConsoleWorkspace, type OpenRequest } from '@/components/console/ConsoleWorkspace';
import { CONSOLE_OPEN_HASH } from '@/lib/consoleOpener';
import { loadTerminalTheme, saveTerminalTheme, THEMES, type ThemeId } from '@/lib/terminalThemes';

// The console is dark whatever the app's theme. Its root carries .dark for its own tree;
// the document follows while it is open, so what is portalled to <body> (menus,
// tooltips, toasts), the scrollbars and the browser's own chrome match it. The app's
// theme is put back on the way out.
function useDarkDocument(ground: string) {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const wasDark = root.classList.contains('dark');
    const scheme = root.style.colorScheme;
    const metas = Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
    const colours = metas.map((m) => m.content);
    root.classList.add('dark');
    root.style.colorScheme = 'dark';
    return () => {
      if (!wasDark) root.classList.remove('dark');
      root.style.colorScheme = scheme;
      metas.forEach((m, i) => { m.content = colours[i]; });
    };
  }, []);
  useEffect(() => {
    for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) m.content = ground;
  }, [ground]);
}

let requests = 0;

// "#open=<uuid>.<n>": the dashboard asks a console window that is already open for
// another VM by changing only the fragment, which never reloads the page (a reload would
// end every session in it). Read once at load too, in case it arrived mid-load.
function readOpenRequest(): OpenRequest | null {
  const m = new RegExp(`^#${CONSOLE_OPEN_HASH}=([0-9a-f-]{36})(?:\\.\\d+)?$`, 'i').exec(window.location.hash);
  if (!m) return null;
  // Take it off the address, so a reload doesn't ask again.
  history.replaceState(history.state, '', window.location.pathname + window.location.search);
  requests += 1;
  return { vmId: m[1].toLowerCase(), nonce: requests };
}

export function VmConsolePage() {
  const { uuid } = useParams<{ uuid: string }>();
  const routeVm = (uuid ?? '').toLowerCase();
  const [themeId, setThemeId] = useState<ThemeId>(() => loadTerminalTheme());
  // Set when this window was opened by the dashboard's Console button (window.open): a
  // dedicated console window, where a link back to the VM's page has nowhere to go.
  // Fixed at load, so the back link never appears later if the dashboard tab closes.
  const [isPopup] = useState(() => typeof window !== 'undefined' && window.opener !== null);
  const [openRequest, setOpenRequest] = useState<OpenRequest | null>(null);
  const ground = THEMES[themeId].palette.background ?? '#0E121A';
  useDarkDocument(ground);

  useEffect(() => {
    const onHash = () => {
      const req = readOpenRequest();
      if (req) {
        setOpenRequest(req);
        window.focus();
      }
    };
    onHash();
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return (
    <div className="dark app-frame flex flex-col bg-background text-foreground">
      <h1 className="sr-only">Console</h1>
      <ConsoleWorkspace
        key={routeVm}
        routeVm={routeVm}
        isPopup={isPopup}
        themeId={themeId}
        onThemeChange={(id) => {
          setThemeId(id);
          saveTerminalTheme(id);
        }}
        openRequest={openRequest}
      />
    </div>
  );
}
