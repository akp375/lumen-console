// Loading placeholders shaped like the content they stand in for.

const bar = "animate-pulse rounded bg-zinc-200 dark:bg-zinc-800";

export function TableSkeleton({ columns = 6, rows = 8 }: { columns?: number; rows?: number }) {
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950" aria-busy="true" aria-label="Loading">
      <div className="flex gap-4 border-b border-zinc-200 bg-zinc-50 px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-900">
        {Array.from({ length: columns }, (_, c) => (
          <div key={c} className={`h-3 flex-1 ${bar}`} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-4 border-b border-zinc-100 px-3 py-3 last:border-0 dark:border-zinc-800/60">
          {Array.from({ length: columns }, (_, c) => (
            <div key={c} className={`h-3 flex-1 ${bar}`} style={{ opacity: 1 - c * 0.08 }} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function BlockSkeleton({ className }: { className: string }) {
  return <div className={`${bar} rounded-lg ${className}`} aria-hidden="true" />;
}

/** Heading line + table skeleton, for a titled table section. */
export function SectionSkeleton({ columns, rows }: { columns?: number; rows?: number }) {
  return (
    <div className="space-y-2">
      <div className={`h-4 w-64 ${bar}`} />
      <div className={`h-3 w-48 ${bar}`} />
      <TableSkeleton columns={columns} rows={rows} />
    </div>
  );
}
