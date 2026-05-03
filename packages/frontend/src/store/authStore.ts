import { create } from 'zustand';
import axios from 'axios';

interface AuthStore {
  token: string | null;
  setToken: (token: string) => void;
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthStore>((set, get) => ({
  token: localStorage.getItem('virtpilotToken'),
  setToken: (token) => {
    localStorage.setItem('virtpilotToken', token);
    set({ token });
  },
  logout: async () => {
    const token = get().token;
    if (token) {
      // Best-effort revocation — server-side revoke list rejects this token
      // for the rest of its TTL. Network failure is fine: we still clear the
      // local copy.
      try {
        await axios.post('/api/auth/logout', null, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 5_000,
        });
      } catch { /* ignore */ }
    }
    localStorage.removeItem('virtpilotToken');
    set({ token: null });
  },
}));
