import { useQuery, useQueryClient } from '@tanstack/react-query';
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
