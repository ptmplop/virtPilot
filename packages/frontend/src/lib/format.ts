export function formatMemory(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

export function formatDisk(gb: number): string {
  if (gb < 1) return `${Math.round(gb * 1024)} MB`;
  return `${gb} GB`;
}
