export type OrderableRoot = {
  id: string;
  updatedAt: number;
};

/**
 * Sort root threads for a bot:
 * - Special threads pinned in threadOrder stay at the top in their saved order.
 * - Newly created / unranked threads sort BEFORE ranked non-special threads (newest first)
 *   so new conversations never sink to the bottom after a reorder or promotion.
 * - Ranked non-special threads follow in their saved threadOrder.
 */
export function sortBotRoots<T extends OrderableRoot>(
  roots: readonly T[],
  threadOrder: readonly string[],
  specialIds: ReadonlySet<string>,
): T[] {
  if (threadOrder.length === 0) {
    return [...roots].sort((a, b) => {
      const sa = specialIds.has(a.id) ? 0 : 1;
      const sb = specialIds.has(b.id) ? 0 : 1;
      if (sa !== sb) return sa - sb;
      return b.updatedAt - a.updatedAt;
    });
  }

  const rank = new Map(threadOrder.map((id, idx) => [id, idx]));
  // Count how many leading ranked threads are special so unranked new threads
  // land right below leading special threads rather than sinking to the bottom.
  const rankedSpecials: T[] = [];
  const unrankedSpecials: T[] = [];
  const unrankedNormal: T[] = [];
  const rankedNormal: T[] = [];

  for (const root of roots) {
    const isSpecial = specialIds.has(root.id);
    const isRanked = rank.has(root.id);
    if (isSpecial && isRanked) rankedSpecials.push(root);
    else if (isSpecial) unrankedSpecials.push(root);
    else if (!isRanked) unrankedNormal.push(root);
    else rankedNormal.push(root);
  }

  rankedSpecials.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  unrankedSpecials.sort((a, b) => b.updatedAt - a.updatedAt);
  unrankedNormal.sort((a, b) => b.updatedAt - a.updatedAt);
  rankedNormal.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);

  // If the user explicitly placed a normal thread BEFORE a special thread in threadOrder,
  // respect the user's relative order among ranked threads while keeping unranked normal threads
  // right after leading ranked specials.
  const firstRankedNormalRank =
    rankedNormal.length > 0 ? rank.get(rankedNormal[0]!.id)! : Number.POSITIVE_INFINITY;
  const leadingSpecials = rankedSpecials.filter((s) => rank.get(s.id)! < firstRankedNormalRank);
  const laterSpecials = rankedSpecials.filter((s) => rank.get(s.id)! >= firstRankedNormalRank);
  const restRanked = [...rankedNormal, ...laterSpecials].sort(
    (a, b) => rank.get(a.id)! - rank.get(b.id)!,
  );

  return [
    ...leadingSpecials,
    ...unrankedSpecials,
    ...unrankedNormal,
    ...restRanked,
  ];
}

/**
 * Identify the single most recently active root thread independent of manual display order.
 * Auto-settle must NEVER settle this thread.
 */
export function mostRecentRootId<T extends OrderableRoot>(
  roots: readonly T[],
  activityOf: (root: T) => number = (r) => r.updatedAt,
): string | null {
  let bestId: string | null = null;
  let bestAt = -Infinity;
  for (const root of roots) {
    const at = activityOf(root);
    if (at > bestAt) {
      bestAt = at;
      bestId = root.id;
    }
  }
  return bestId;
}
