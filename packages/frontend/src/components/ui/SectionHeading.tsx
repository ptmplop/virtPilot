// A section heading is its label followed by a hairline that runs to the edge of the
// column: the rule groups what follows without boxing it.
export function SectionHeading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3">
      <h2 className="shrink-0 text-[13px] font-semibold text-foreground">{label}</h2>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}
