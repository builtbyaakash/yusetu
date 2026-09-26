import { useMemo, useState } from "react";

export const PAGE_SIZE = 25;

type PaginationProps = {
  total: number;
  page: number;
  pageSize?: number;
  onPageChange: (page: number) => void;
};

export function Pagination({
  total,
  page,
  pageSize = PAGE_SIZE,
  onPageChange,
}: PaginationProps) {
  if (total <= pageSize) return null;

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const from = (safePage - 1) * pageSize + 1;
  const to = Math.min(safePage * pageSize, total);

  return (
    <div className="pagination" role="navigation" aria-label="Pagination">
      <span className="pagination-meta">
        Showing {from}–{to} of {total}
      </span>
      <div className="row-actions">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={safePage <= 1}
          onClick={() => onPageChange(safePage - 1)}
        >
          Prev
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={safePage >= totalPages}
          onClick={() => onPageChange(safePage + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}

export function useClientPage<T>(items: T[], pageSize = PAGE_SIZE) {
  const [page, setPage] = useState(1);
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize) || 1);
  const safePage = Math.min(Math.max(1, page), totalPages);

  const pageItems = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return items.slice(start, start + pageSize);
  }, [items, safePage, pageSize]);

  return {
    page: safePage,
    setPage,
    pageItems,
    total,
    pageSize,
  };
}
