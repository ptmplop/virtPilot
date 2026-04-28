import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface LogoStore {
  templates: Record<string, string>;
  isos: Record<string, string>;
  vms: Record<string, string>;
  setTemplateLogo: (filename: string, slug: string | null) => void;
  setIsoLogo: (filename: string, slug: string | null) => void;
  setVmLogo: (vmName: string, slug: string | null) => void;
}

const removeKey = (obj: Record<string, string>, key: string) =>
  Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));

export const useLogoStore = create<LogoStore>()(
  persist(
    (set) => ({
      templates: {},
      isos: {},
      vms: {},
      setTemplateLogo: (filename, slug) =>
        set((s) => ({
          templates: slug ? { ...s.templates, [filename]: slug } : removeKey(s.templates, filename),
        })),
      setIsoLogo: (filename, slug) =>
        set((s) => ({
          isos: slug ? { ...s.isos, [filename]: slug } : removeKey(s.isos, filename),
        })),
      setVmLogo: (vmName, slug) =>
        set((s) => ({
          vms: slug ? { ...s.vms, [vmName]: slug } : removeKey(s.vms, vmName),
        })),
    }),
    { name: 'virtpilot-logos' }
  )
);
