import Link from 'next/link';

export function Pagination({
  path,
  page,
  pageSize,
  total,
  query = {},
}: {
  path: string;
  page: number;
  pageSize: number;
  total: number;
  query?: Record<string, string | undefined>;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return <p className="px-5 py-3 text-xs text-gray-500">{total} record{total === 1 ? '' : 's'}</p>;

  function href(target: number): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value) params.set(key, value);
    }
    params.set('page', String(target));
    return `${path}?${params.toString()}`;
  }

  return (
    <div className="flex items-center justify-between gap-3 px-5 py-3 text-sm text-gray-600">
      <p>
        {total} record{total === 1 ? '' : 's'} · page {page} of {pages}
      </p>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link className="font-medium text-brand-700 hover:underline" href={href(page - 1)}>
            Previous
          </Link>
        ) : null}
        {page < pages ? (
          <Link className="font-medium text-brand-700 hover:underline" href={href(page + 1)}>
            Next
          </Link>
        ) : null}
      </div>
    </div>
  );
}
