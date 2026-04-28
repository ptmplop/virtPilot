import { create } from 'zustand';

interface VmOpsState {
  pendingSnapshot: Record<string, string | null>;
  pendingRevert: Record<string, string | null>;
  pendingConvert: Record<string, string | null>;
  setPendingSnapshot: (vmName: string, name: string | null) => void;
  setPendingRevert: (vmName: string, name: string | null) => void;
  setPendingConvert: (vmName: string, name: string | null) => void;
}

export const useVmOpsStore = create<VmOpsState>((set) => ({
  pendingSnapshot: {},
  pendingRevert: {},
  pendingConvert: {},
  setPendingSnapshot: (vmName, name) =>
    set((s) => ({ pendingSnapshot: { ...s.pendingSnapshot, [vmName]: name } })),
  setPendingRevert: (vmName, name) =>
    set((s) => ({ pendingRevert: { ...s.pendingRevert, [vmName]: name } })),
  setPendingConvert: (vmName, name) =>
    set((s) => ({ pendingConvert: { ...s.pendingConvert, [vmName]: name } })),
}));
