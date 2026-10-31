// One control for a VXLAN's remote hosts, in New network and in the Remote hosts dialog.
export function RemoteHostsField({
  value, onChange, rows, help,
}: {
  value: string;
  onChange: (value: string) => void;
  rows: number;
  help: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor="vxlan-peers" className="block text-[13px] font-semibold text-foreground">Remote hosts</label>
      <textarea
        id="vxlan-peers"
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={'203.0.113.10\n203.0.113.11'}
        spellCheck={false}
        className="block w-full resize-y rounded-md border border-input bg-field px-3 py-2 font-mono text-[13px] leading-5 text-foreground placeholder:text-muted-foreground/70 transition-[border-color,box-shadow] duration-150 hover:border-muted-foreground/40 focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-ring/20"
      />
      <p className="text-[12px] text-muted-foreground">{help}</p>
    </div>
  );
}

export function parseRemoteHosts(text: string): string[] {
  return text.split(/[\s,]+/).filter(Boolean);
}
