import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface SystemInfo {
  hostname: string;
  cpuModel: string;
  cpuCores: number;
  load: [number, number, number];
  kernelVersion: string;
}

export interface StatsSample {
  timestamp: number;
  cpuPercent: number;
  memUsedMb: number;
  memTotalMb: number;
  diskReadBps: number;
  diskWriteBps: number;
  netRxBps: number;
  netTxBps: number;
  diskUsedGb: number;
  diskTotalGb: number;
}

export interface AptPackage {
  name: string;
  version: string;
  arch: string;
  currentVersion: string;
}

export function useSystemStats() {
  return useQuery({
    queryKey: ['system', 'stats'],
    queryFn: async () => {
      const { data } = await api.get<{ current: StatsSample; history: StatsSample[] }>('/api/system/stats');
      return data;
    },
    refetchInterval: 2000,
    staleTime: 0,
  });
}

export type SystemMetricsRange = '1h' | '24h';

export interface SystemMetricsPoint {
  ts: number;
  cpuPercent: number;
  memUsedMb: number;
  memTotalMb: number;
  diskReadBps: number;
  diskWriteBps: number;
  netRxBps: number;
  netTxBps: number;
}

interface SystemMetricsResponse {
  range: SystemMetricsRange;
  history: SystemMetricsPoint[];
}

export function useSystemMetricsHistory(range: SystemMetricsRange, enabled = true) {
  return useQuery({
    queryKey: ['system', 'metrics', range],
    queryFn: async () => {
      const { data } = await api.get<SystemMetricsResponse>('/api/system/metrics', { params: { range } });
      return data;
    },
    enabled,
    refetchInterval: range === '1h' ? 30_000 : 5 * 60_000,
    retry: false,
  });
}

export function useAptPackages() {
  return useQuery({
    queryKey: ['system', 'apt'],
    queryFn: async () => {
      const { data } = await api.get<{ packages: AptPackage[] }>('/api/system/apt');
      return data.packages;
    },
    refetchInterval: 60_000,
  });
}

export function useSystemInfo() {
  return useQuery({
    queryKey: ['system', 'info'],
    queryFn: async () => {
      const { data } = await api.get<SystemInfo>('/api/system/info');
      return data;
    },
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}

export function useInvalidateApt() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['system', 'apt'] });
}

export interface VirtPilotVersion {
  current: string;
  latest: string | null;
  latestTag: string | null;
  releaseUrl: string | null;
  releaseNotes: string | null;
  publishedAt: string | null;
  updateAvailable: boolean;
  repoOk: boolean;
  repoReason: string | null;
  repoPath: string;
}

export function useVirtPilotVersion() {
  return useQuery({
    queryKey: ['system', 'version'],
    queryFn: async () => {
      const { data } = await api.get<VirtPilotVersion>('/api/system/version');
      return data;
    },
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  });
}

export function useInvalidateVersion() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['system', 'version'] });
}

// Forces the backend to bypass its 10-minute GitHub release cache. Used by the
// "Check now" button on the dashboard so users don't have to wait for the
// next polling interval to discover a new release.
export function useCheckVersionNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.get<VirtPilotVersion>('/api/system/version?force=1');
      return data;
    },
    onSuccess: (data) => {
      qc.setQueryData(['system', 'version'], data);
    },
  });
}
