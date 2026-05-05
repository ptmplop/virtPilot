import { useEffect } from 'react';
import { Select } from '@/components/ui/Select';
import { useStorageDirs } from '@/hooks/useStorageDirs';
import type { StorageDirPurpose } from '@/types';

interface Props {
  purpose: StorageDirPurpose;
  value: string;
  onChange: (id: string) => void;
  label?: string;
  disabled?: boolean;
  // Drop a dir from the dropdown — used by MoveDialog to exclude the source
  // dir so the operator can't pick "move to where it already lives".
  excludeId?: string;
}

// Filtered storage-dir picker. Auto-selects the purpose's default on mount if
// the caller hasn't already chosen one — common case is the operator just
// hits "Upload" without thinking about storage and gets the default location.
export function StorageDirSelect({ purpose, value, onChange, label = 'Storage', disabled, excludeId }: Props) {
  const { data: dirs = [] } = useStorageDirs();
  const eligible = dirs.filter((d) => d.purposes.includes(purpose) && d.id !== excludeId);

  useEffect(() => {
    if (value || eligible.length === 0) return;
    const defaultFlag =
      purpose === 'templates' ? 'isDefaultTemplates' :
      purpose === 'isos' ? 'isDefaultIsos' : 'isDefaultVmDisks';
    const preferred = eligible.find((d) => d[defaultFlag]) ?? eligible[0];
    onChange(preferred.id);
  }, [value, eligible, onChange, purpose]);

  if (eligible.length === 0) {
    return (
      <div className="space-y-1">
        <label className="text-xs font-medium text-foreground">{label}</label>
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
          {excludeId
            ? `No other storage directory configured for ${purpose}. Add one on the Storage page.`
            : `No storage directory configured for ${purpose}. Add one on the Storage page.`}
        </p>
      </div>
    );
  }

  return (
    <Select label={label} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      {eligible.map((d) => (
        <option key={d.id} value={d.id}>
          {d.name}
          {(purpose === 'templates' && d.isDefaultTemplates) ||
          (purpose === 'isos' && d.isDefaultIsos) ||
          (purpose === 'vmDisks' && d.isDefaultVmDisks)
            ? ' (default)'
            : ''}
        </option>
      ))}
    </Select>
  );
}
