import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

interface UserPrefsState {
  // When true, the Console button on the VMs list and VM detail page opens
  // VmConsole in a compact popup window. When false, it navigates in the
  // current tab. Defaults to popup so a console session doesn't take over the
  // dashboard tab — anyone who prefers in-tab toggles it off once and persist
  // remembers that choice.
  //
  // Persisted to localStorage via zustand `persist`. The store key
  // (`virtpilotUserPrefs`) is separate from the auth token so the choice
  // survives sign-out / sign-in on the same browser. It's per-device by
  // design.
  openConsoleInPopup: boolean;
  setOpenConsoleInPopup: (value: boolean) => void;
}

export const useUserPrefsStore = create<UserPrefsState>()(
  persist(
    (set) => ({
      openConsoleInPopup: true,
      setOpenConsoleInPopup: (value) => set({ openConsoleInPopup: value }),
    }),
    {
      name: 'virtpilotUserPrefs',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
