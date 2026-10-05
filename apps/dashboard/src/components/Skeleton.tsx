type TableSkeletonProps = {
  rows?: number;
  cols?: number;
};

export function TableSkeleton({ rows = 5, cols = 5 }: TableSkeletonProps) {
  return (
    <div className="table-wrap" aria-hidden="true">
      <table className="data-table">
        <thead>
          <tr>
            {Array.from({ length: cols }, (_, i) => (
              <th key={i}>
                <span className="skeleton skeleton-line skeleton-line--sm" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r}>
              {Array.from({ length: cols }, (_, c) => (
                <td key={c}>
                  <span className="skeleton skeleton-line" />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty empty--guided">
      <h2 className="empty-title">{title}</h2>
      <p className="empty-body">{body}</p>
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}
