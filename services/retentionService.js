export const RETENTION_POLICY = {
  maxActiveRecords: 50,
  activeMonths: 6,
};

function recordTime(record) {
  const dateTime = record?.date ? new Date(record.date).getTime() : 0;
  const createdTime = record?.createdAt ? new Date(record.createdAt).getTime() : 0;
  return { dateTime: Number.isFinite(dateTime) ? dateTime : 0, createdTime: Number.isFinite(createdTime) ? createdTime : 0 };
}

function sortRecords(records = []) {
  return [...records].sort((a, b) => {
    const timeA = recordTime(a);
    const timeB = recordTime(b);
    if (timeA.dateTime !== timeB.dateTime) return timeA.dateTime - timeB.dateTime;
    if (timeA.createdTime !== timeB.createdTime) return timeA.createdTime - timeB.createdTime;
    return String(a.id || "").localeCompare(String(b.id || ""));
  });
}

function cutoffDate(anchorDate = new Date(), months = RETENTION_POLICY.activeMonths) {
  const cutoff = new Date(anchorDate);
  cutoff.setMonth(cutoff.getMonth() - months);
  cutoff.setHours(0, 0, 0, 0);
  return cutoff;
}

function archiveKey(record) {
  return record?.id || `${record?.date || "no-date"}:${record?.createdAt || ""}:${record?.kh ?? ""}:${record?.ca ?? ""}:${record?.mg ?? ""}`;
}

function mergeArchive(existingArchive = [], recordsToArchive = []) {
  const merged = new Map();
  for (const record of [...existingArchive, ...recordsToArchive]) {
    merged.set(archiveKey(record), record);
  }
  return sortRecords([...merged.values()]);
}

export function splitActiveAndArchivedRecords({
  activeRecords = [],
  archivedRecords = [],
  anchorDate = new Date(),
  policy = RETENTION_POLICY,
} = {}) {
  const cutoff = cutoffDate(anchorDate, policy.activeMonths);
  const sortedActive = sortRecords(activeRecords);
  const recentRecords = sortedActive.filter((record) => record.date && new Date(record.date) >= cutoff);
  const oldRecords = sortedActive.filter((record) => !record.date || new Date(record.date) < cutoff);
  const newestRecent = recentRecords.slice(-policy.maxActiveRecords);
  const overLimit = recentRecords.slice(0, Math.max(0, recentRecords.length - newestRecent.length));

  return {
    activeRecords: newestRecent,
    archivedRecords: mergeArchive(archivedRecords, [...oldRecords, ...overLimit]),
    archivedCount: oldRecords.length + overLimit.length,
    policy,
  };
}
