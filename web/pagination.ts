export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: number;
}

export type CursorPageReader<T> = (cursor: number | undefined) => Promise<CursorPage<T>>;

function assertCursor(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("nextCursor must be a non-negative safe integer");
  }
  return value;
}

/**
 * Read every page exactly once. Cursor cycles fail visibly instead of silently
 * hiding older memory/identity records or spinning forever.
 */
export async function collectCursorPages<T>(
  readPage: CursorPageReader<T>,
  maxPages = 10_000
): Promise<T[]> {
  if (!Number.isSafeInteger(maxPages) || maxPages <= 0) {
    throw new RangeError("maxPages must be a positive safe integer");
  }

  const items: T[] = [];
  const seenCursors = new Set<number>();
  let cursor: number | undefined;

  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const page = await readPage(cursor);
    items.push(...page.items);
    if (page.nextCursor === undefined) {
      return items;
    }

    const nextCursor = assertCursor(page.nextCursor);
    if (seenCursors.has(nextCursor)) {
      throw new Error(`record pagination cursor repeated: ${nextCursor}`);
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  throw new Error(`record pagination exceeded ${maxPages} pages`);
}
