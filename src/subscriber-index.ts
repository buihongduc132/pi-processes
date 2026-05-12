// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Filter criteria for a watch subscription.
 *
 * - `includeTagsAny` – match if the watch has **any** of these tags (OR).
 * - `includeTagsAll` – match only if the watch has **all** of these tags (AND).
 * - `includeLabels`  – match if the watch has **any** of these labels (OR).
 * - `excludeTagsAny` – reject if the watch has **any** of these tags.
 * - `excludeLabels`  – reject if the watch has **any** of these labels.
 *
 * Tag and label criteria are combined with AND. An empty subscription matches
 * everything.
 */
export interface WatchSubscription {
  includeTagsAny?: string[];
  includeTagsAll?: string[];
  includeLabels?: string[];
  excludeTagsAny?: string[];
  excludeLabels?: string[];
}

/** Internal record linking a subscription to its cwd. */
interface SubEntry {
  cwd: string;
  subscription: WatchSubscription;
}

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

/** Whether an array is non-empty. */
const hasItems = (arr: string[] | undefined): arr is string[] =>
  !!(arr && arr.length > 0);

/** Whether `watchTags` satisfies the include-tags portion of a subscription. */
function tagsMatch(sub: WatchSubscription, watchTags: string[]): boolean {
  const hasAny = hasItems(sub.includeTagsAny);
  const hasAll = hasItems(sub.includeTagsAll);

  if (!hasAny && !hasAll) return true;

  let ok = true;
  if (hasAny) ok = sub.includeTagsAny!.some((t) => watchTags.includes(t));
  if (ok && hasAll) ok = sub.includeTagsAll!.every((t) => watchTags.includes(t));
  return ok;
}

/** Whether `watchLabels` satisfies the include-labels portion of a subscription. */
function labelsMatch(sub: WatchSubscription, watchLabels: string[]): boolean {
  if (!hasItems(sub.includeLabels)) return true;
  return sub.includeLabels!.some((l) => watchLabels.includes(l));
}

/** Whether a subscription's include criteria are fully satisfied by the given watch. */
function isIncluded(sub: WatchSubscription, watchTags: string[], watchLabels: string[]): boolean {
  const hasTagCriteria = hasItems(sub.includeTagsAny) || hasItems(sub.includeTagsAll);
  const hasLabelCriteria = hasItems(sub.includeLabels);

  // Empty subscription = wildcard match
  if (!hasTagCriteria && !hasLabelCriteria) return true;

  const tagOk = tagsMatch(sub, watchTags);
  const labelOk = labelsMatch(sub, watchLabels);

  if (hasTagCriteria && hasLabelCriteria) return tagOk && labelOk;
  if (hasTagCriteria) return tagOk;
  return labelOk;
}

/** Whether a watch should be excluded based on the subscription's exclude criteria. */
function isExcluded(sub: WatchSubscription, watchTags: string[], watchLabels: string[]): boolean {
  if (hasItems(sub.excludeTagsAny) && sub.excludeTagsAny!.some((t) => watchTags.includes(t))) {
    return true;
  }
  if (hasItems(sub.excludeLabels) && sub.excludeLabels!.some((l) => watchLabels.includes(l))) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Map helper
// ---------------------------------------------------------------------------

/** Get or create a `V` in a `Map<K, V>` (avoids repeated get/check/set boilerplate). */
function getOrInit<K, V>(map: Map<K, V>, key: K, factory: () => V): V {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const created = factory();
  map.set(key, created);
  return created;
}

// ---------------------------------------------------------------------------
// SubscriberIndex
// ---------------------------------------------------------------------------

/**
 * In-memory index that maps sessions to their watch subscriptions and supports
 * efficient "which sessions should be notified for these tags/labels?" queries.
 *
 * Sessions may subscribe multiple times (additive). A session matches a
 * resolveTargets call if **any single** subscription satisfies the include
 * criteria and does NOT trigger an exclusion for that same subscription.
 */
export class SubscriberIndex {
  /** sessionId → array of subscriptions (additive). */
  private readonly sessionSubs = new Map<string, SubEntry[]>();
  /** cwd → set of sessionIds that have at least one subscription in that cwd. */
  private readonly cwdIndex = new Map<string, Set<string>>();

  /**
   * Add a watch subscription for a session.
   *
   * @param sessionId   - Unique session identifier.
   * @param cwd         - Working directory to scope the subscription.
   * @param subscription - Filter criteria for this subscription.
   */
  subscribe(sessionId: string, cwd: string, subscription: WatchSubscription): void {
    const entries = getOrInit(this.sessionSubs, sessionId, () => []);
    entries.push({ cwd, subscription });

    const cwdSet = getOrInit(this.cwdIndex, cwd, () => new Set<string>());
    cwdSet.add(sessionId);
  }

  /**
   * Remove all subscriptions for a session.
   *
   * Cleans up both the per-session map and the cwd reverse index.
   */
  unsubscribe(sessionId: string): void {
    this.sessionSubs.delete(sessionId);
    for (const sessions of this.cwdIndex.values()) {
      sessions.delete(sessionId);
    }
  }

  /**
   * Find all sessions that should be notified for a given watch event.
   *
   * A session is included if **any single** subscription both matches the include
   * criteria AND does NOT trigger an exclusion. Exclusion from one subscription
   * cannot veto another subscription's match.
   *
   * @param cwd         - Working directory to scope the query.
   * @param watchTags   - Tags present on the triggering event.
   * @param watchLabels - Labels present on the triggering event.
   * @returns Session IDs that should receive the notification.
   */
  resolveTargets(cwd: string, watchTags: string[], watchLabels: string[]): string[] {
    const cwdSessions = this.cwdIndex.get(cwd);
    if (!cwdSessions) return [];

    const results: string[] = [];

    for (const sessionId of cwdSessions) {
      const entries = this.sessionSubs.get(sessionId);
      if (!entries) continue;

      for (const entry of entries) {
        if (entry.cwd !== cwd) continue;
        if (isIncluded(entry.subscription, watchTags, watchLabels) && !isExcluded(entry.subscription, watchTags, watchLabels)) {
          results.push(sessionId);
          break; // one qualifying subscription is enough
        }
      }
    }

    return results;
  }
}
