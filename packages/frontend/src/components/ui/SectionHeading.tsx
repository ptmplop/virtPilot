// A section heading is its label, a short steel tick — the logo's needle, laid flat —
// and a hairline that runs to the edge of the column. The rule groups what follows
// without boxing it.
export function SectionHeading({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <h2 className="flex shrink-0 items-center gap-2 text-[14px] font-semibold tracking-[-0.006em] text-foreground">
        <span aria-hidden className="h-[9px] w-[3px] -skew-x-[18deg] rounded-[1px] bg-[#4F7CAC] dark:bg-[#86AEDA]" />
        {label}
      </h2>
      <div className="h-px flex-1 bg-border" />
      {children}
    </div>
  );
}
