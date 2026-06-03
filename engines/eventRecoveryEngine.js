const RECOVERY_EVENT_KEYWORDS = [
  "tube_air_leak",
  "air_leak",
  "tube_fixed",
  "leak_fixed",
  "tube_blocked",
  "tube_replaced",
  "air_purge",
  "brand_changed",
  "concentration_changed",
  "doser_changed",
  "dosing_restored",
  "long_pause_restored",
];

const ELEMENT_ALIASES = {
  kh: "kh",
  alk: "kh",
  ca: "ca",
  calcium: "ca",
  mg: "mg",
  magnesium: "mg",
};

function normalizeElement(value) {
  const key = String(value || "").trim().toLowerCase();
  return ELEMENT_ALIASES[key] || key;
}

function normalizeDate(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text.slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function daysBetween(startDate, endDate) {
  if (!startDate || !endDate) return null;
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return Math.floor((end - start) / 86400000);
}

function isRecoveryEvent(event) {
  if (!event || typeof event !== "object") return false;
  if (event.event_recovery_mode === true || event.recoveryMode === true) return true;
  const eventType = String(event.event_type || event.eventType || event.type || "").toLowerCase();
  return RECOVERY_EVENT_KEYWORDS.some((keyword) => eventType.includes(keyword));
}

function normalSamplesSince({ records = [], startDate, element, target }) {
  if (!startDate || !element || !target) return 0;
  return records.filter((record) => {
    if (!record.date || record.date < startDate) return false;
    if (record.measuredFields && record.measuredFields[element] === false) return false;
    const value = Number(record[element]);
    return Number.isFinite(value) && value >= target.min && value <= target.max;
  }).length;
}

export function buildRecoveryContext({ events = [], latestDate = "", records = [], targets = {} } = {}) {
  const activeEvents = events
    .filter(isRecoveryEvent)
    .map((event) => {
      const startDate = normalizeDate(event.event_start_date || event.start_date || event.startDate || event.date || event.createdAt);
      const recoveryDays = Math.max(0, Number(event.expected_recovery_days ?? event.recovery_days ?? event.recoveryDays ?? 14) || 0);
      const elapsedDays = daysBetween(startDate, latestDate);
      const affectedElement = normalizeElement(event.affected_element || event.affectedElement || event.element || event.parameter);
      const normalSamples = normalSamplesSince({
        records,
        startDate,
        element: affectedElement,
        target: targets[affectedElement],
      });
      return {
        event_type: event.event_type || event.eventType || event.type || "system_recovery_event",
        affected_element: affectedElement,
        start_date: startDate,
        recovery_days: recoveryDays,
        elapsed_days: elapsedDays,
        normal_samples_since_event: normalSamples,
        source_event: event,
        active: elapsedDays === null ? true : elapsedDays >= 0 && (elapsedDays <= recoveryDays || normalSamples < 2),
      };
    })
    .filter((event) => event.active);

  return {
    event_recovery_mode: activeEvents.length > 0,
    active_events: activeEvents,
  };
}

export function recoveryContextForElement(recoveryContext, element) {
  const normalizedElement = normalizeElement(element);
  const activeEvents = (recoveryContext?.active_events || []).filter((event) => (
    !event.affected_element || event.affected_element === normalizedElement
  ));
  const firstEvent = activeEvents[0] || null;

  return {
    event_recovery_mode: activeEvents.length > 0,
    affected_element: firstEvent?.affected_element || normalizedElement,
    event_type: firstEvent?.event_type || "",
    event_start_date: firstEvent?.start_date || "",
    expected_recovery_days: firstEvent?.recovery_days || 0,
    elapsed_recovery_days: firstEvent?.elapsed_days ?? null,
    active_events: activeEvents,
  };
}
