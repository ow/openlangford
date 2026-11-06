/** The matters index page's data shaping: which ids are on a page, and putting fetched rows back in index order. */
export const MATTERS_PAGE_SIZE = 50;

export function pageOf<T>(index: T[], page: number, size = MATTERS_PAGE_SIZE): T[] {
  return index.slice((page - 1) * size, page * size);
}

/** Rows for a page, in the index's order; rows not on the page are dropped, and ids with no row are skipped. */
export function orderLike<R extends { id: number }>(rows: R[], pageIndex: { id: number }[]): R[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return pageIndex.map((p) => byId.get(p.id)).filter((r): r is R => !!r);
}
