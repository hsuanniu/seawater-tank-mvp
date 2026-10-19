export const MANUAL_HISTORY_TYPES = ["refill", "calibrate", "correct"];

export function effectiveManualEvents(events = [], at = Infinity) {
  const corrections = events.filter((e) => e.type === "correct" && Date.parse(e.at) <= at);
  return events.filter((e) => e.type !== "correct" && Date.parse(e.at) <= at).map((event) => {
    const latest = corrections.filter((e) => e.targetEventId === event.id && e.targetType === event.type).at(-1);
    return latest ? { ...event, amountMl: latest.amountMl, notes: latest.notes } : event;
  });
}

export function reservoirManualHistory(reservoir, ledger = []) {
  const events = reservoir.manualEvents || [];
  return events.filter((e) => ["refill", "calibrate"].includes(e.type)).map((event, index) => {
    const audit = ledger.find((row) => row.reservoir_id === reservoir.id && row.type === event.type && row.metadata?.id === event.id);
    const corrections = events.filter((e) => e.type === "correct" && e.targetEventId === event.id && e.targetType === event.type);
    const latest = corrections.at(-1);
    return {
      id: event.id, type: event.type, reservoirId: reservoir.id, tankId: reservoir.tankId,
      name: reservoir.name, doseKey: reservoir.doseKey, occurredAt: event.at,
      amountMl: event.amountMl, effectiveAmountMl: latest?.amountMl ?? event.amountMl,
      beforeMl: event.beforeMl ?? audit?.before_ml ?? null,
      afterMl: event.afterMl ?? audit?.after_ml ?? (event.type === "calibrate" ? event.amountMl : null),
      beforeQuality: event.beforeQuality || audit?.metadata?.before?.quality || "unknown",
      notes: event.notes || "", effectiveNotes: latest?.notes ?? event.notes ?? "",
      reason: event.reason || "", source: event.source || "manual_app",
      revisionId: latest?.id || event.id, corrected: corrections.length > 0,
      corrections: corrections.map((e) => ({ id: e.id, recordedAt: e.at, reason: e.reason,
        previousAmountMl: e.previousAmountMl, amountMl: e.amountMl, previousNotes: e.previousNotes,
        notes: e.notes, beforeRemainingMl: e.beforeMl, afterRemainingMl: e.afterMl })),
      order: index,
    };
  }).sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || b.order - a.order)
    .map(({ order, ...entry }) => entry);
}

// Older reef-only snapshots have no explicit type. Explicit freshwater entries never cross this boundary.
export function isReefTank(entry) {
  const type = entry?.aquariumType ?? entry?.waterType ?? entry?.type ?? entry?.tank?.aquariumType ?? entry?.tank?.waterType ?? entry?.tank?.type;
  return type === undefined || type === null || ["reef", "marine", "saltwater", "seawater"].includes(type);
}
