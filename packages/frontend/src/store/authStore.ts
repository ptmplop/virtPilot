import { create } from 'zustand';

interface AuthStore {
  token: string | null;
  setToken: (token: string) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthStore>((set) => ({
  token: localStorage.getItem('virtpilotToken'),
  setToken: (token) => {
    localStorage.setItem('virtpilotToken', token);
    set({ token });
  },
  logout: () => {
    localStorage.removeItem('virtpilotToken');
    set({ token: null });
  },
}));
