import type { ReactNode } from 'react';

export interface TableShellProps {
  headers: ReactNode[];
  className?: string;
  children: ReactNode;
}

export function TableShell({ headers, className = '', children }: TableShellProps) {
  return (
    <div className={`overflow-x-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-sm ${className}`.trim()}>
      <table className="w-full text-left">
        <thead className="border-b border-[var(--border)] text-sm text-[var(--text-secondary)]">
          <tr>
            {headers.map((header, index) => (
              <th key={index} className="p-4">{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
