import { additiveLabel } from "./additiveLogModule.js";
import { foodLabel } from "./feedingLogModule.js";

export const TIMELINE_EVENT_TYPES = [
  { value: "all", label: "全部事件" },
  { value: "measurement", label: "水質測量" },
  { value: "dosing-apply", label: "滴定套用" },
  { value: "water-change", label: "換水" },
  { value: "feeding", label: "餵食" },
  { value: "additive", label: "添加物" },
  { value: "fish", label: "魚隻" },
  { value: "system-event", label: "系統事件" },
];

function eventId(prefix, id, suffix = "") {
  return `${prefix}:${id || "unknown"}${suffix ? `:${suffix}` : ""}`;
}

function dateFromAppliedAt(value) {
  const text = String(value || "");
  const parts = text.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (!parts) return text.slice(0, 10);
  return `${parts[1]}-${parts[2].padStart(2, "0")}-${parts[3].padStart(2, "0")}`;
}

function numberText(value, fallback = "-") {
  if (value === "" || value === null || value === undefined || Number.isNaN(Number(value))) return fallback;
  return String(value);
}

function createTimelineEvent({
  id,
  tankId,
  type,
  date,
  title,
  summary,
  relatedRecordId = null,
  metadata = {},
}) {
  return { id, tankId, type, date, title, summary, relatedRecordId, metadata };
}

function measurementEvents(tankId, records = []) {
  return records.map((record) => createTimelineEvent({
    id: eventId("measurement", record.id),
    tankId,
    type: "measurement",
    date: record.date,
    title: "水質測量",
    summary: `KH ${numberText(record.kh)}｜CA ${numberText(record.ca)}｜MG ${numberText(record.mg)}｜NO3 ${numberText(record.no3)}｜PO4 ${numberText(record.po4)}`,
    relatedRecordId: record.id || null,
    metadata: {
      note: record.note || "",
      measuredFields: record.measuredFields || null,
      salinity: record.salinity || "",
      temperature: record.temperature || "",
    },
  }));
}

function dosingEvents(tankId, applications = []) {
  return applications.map((application) => createTimelineEvent({
    id: eventId("dosing", application.id),
    tankId,
    type: "dosing-apply",
    date: application.date || dateFromAppliedAt(application.appliedAt),
    title: `${application.label || application.parameter || "滴定"} 建議已套用`,
    summary: `${numberText(application.oldDose ?? application.oldDoseMlPerDay, "0")} -> ${numberText(application.newDose ?? application.newDoseMlPerDay, "0")} ml/day`,
    relatedRecordId: application.relatedMeasurementId || application.recordId || null,
    metadata: {
      appliedAt: application.appliedAt || "",
      parameter: application.parameter || "",
      changeAmount: application.changeAmount ?? application.doseChangeMlPerDay ?? 0,
      reason: application.reason || application.reasonText || "",
    },
  }));
}

function waterChangeEvents(tankId, maintenance = []) {
  return maintenance
    .filter((entry) => Number(entry.waterChangeCount) > 0 || Number(entry.waterChangeVolume) > 0)
    .map((entry) => createTimelineEvent({
      id: eventId("water-change", entry.id),
      tankId,
      type: "water-change",
      date: entry.date,
      title: "換水",
      summary: `${numberText(entry.waterChangeCount, "0")} 次｜每次 ${numberText(entry.waterChangeVolume, "0")} L${entry.note ? `｜${entry.note}` : ""}`,
      metadata: {
        waterChangeCount: entry.waterChangeCount || 0,
        waterChangeVolume: entry.waterChangeVolume || 0,
        note: entry.note || "",
        newFish: Boolean(entry.newFish),
        newCoral: Boolean(entry.newCoral),
        moreFeeding: Boolean(entry.moreFeeding),
        changedAdditive: Boolean(entry.changedAdditive),
      },
    }));
}

function feedingEvents(tankId, feedings = []) {
  return feedings.map((feeding) => createTimelineEvent({
    id: eventId("feeding", feeding.id),
    tankId,
    type: "feeding",
    date: feeding.date,
    title: "餵食紀錄",
    summary: `${feeding.amountLevel || "未填量"}｜${feeding.frequency || "未填頻率"}｜${(feeding.foodTypes || []).map(foodLabel).join("、") || "未填種類"}`,
    metadata: {
      amountLevel: feeding.amountLevel || "",
      frequency: feeding.frequency || "",
      foodTypes: feeding.foodTypes || [],
      note: feeding.note || "",
    },
  }));
}

function additiveEvents(tankId, additives = []) {
  return additives.map((additive) => createTimelineEvent({
    id: eventId("additive", additive.id),
    tankId,
    type: "additive",
    date: additive.date,
    title: additive.itemLabel || additiveLabel(additive.item),
    summary: `${numberText(additive.doseMl, "0")} ml｜${additive.frequency || "單次"}${additive.autoDosed ? "｜自動滴定" : ""}${additive.coralFed ? "｜餵珊瑚" : ""}`,
    metadata: {
      item: additive.item || "",
      doseMl: additive.doseMl || 0,
      frequency: additive.frequency || "",
      autoDosed: Boolean(additive.autoDosed),
      coralFed: Boolean(additive.coralFed),
      note: additive.note || "",
    },
  }));
}

function fishEvents(tankId, livestock = []) {
  return livestock.flatMap((fish) => {
    const events = [createTimelineEvent({
      id: eventId("fish", fish.id, "added"),
      tankId,
      type: "fish",
      date: fish.addedAt,
      title: "新增魚隻",
      summary: `${fish.name || "未命名魚隻"} x${numberText(fish.quantity, "1")}`,
      metadata: { action: "added", fishId: fish.id || "", removed: Boolean(fish.removed) },
    })];
    if (fish.removed && fish.removedAt) {
      events.push(createTimelineEvent({
        id: eventId("fish", fish.id, "removed"),
        tankId,
        type: "fish",
        date: fish.removedAt,
        title: "移除魚隻",
        summary: `${fish.name || "未命名魚隻"} x${numberText(fish.quantity, "1")}`,
        metadata: { action: "removed", fishId: fish.id || "" },
      }));
    }
    return events;
  });
}

function systemEvents(tankId, events = []) {
  return events.map((event) => createTimelineEvent({
    id: eventId("system", event.id),
    tankId,
    type: "system-event",
    date: event.start_date || event.event_start_date || event.date || String(event.createdAt || "").slice(0, 10),
    title: event.title || event.event_type || event.eventType || "系統事件",
    summary: event.summary || `${event.affected_element || event.affectedElement || event.element || "未指定元素"}｜恢復期 ${event.recovery_days ?? event.expected_recovery_days ?? event.recoveryDays ?? 14} 天`,
    relatedRecordId: event.relatedRecordId || null,
    metadata: {
      event_type: event.event_type || event.eventType || event.type || "",
      affected_element: event.affected_element || event.affectedElement || event.element || "",
      start_date: event.start_date || event.event_start_date || event.startDate || event.date || "",
      recovery_days: event.recovery_days ?? event.expected_recovery_days ?? event.recoveryDays ?? 14,
      event_recovery_mode: event.event_recovery_mode === true || event.recoveryMode === true,
      note: event.note || "",
    },
  }));
}

export function buildTimelineEvents(tankData) {
  if (!tankData) return [];
  const events = [
    ...measurementEvents(tankData.id, tankData.records),
    ...dosingEvents(tankData.id, tankData.doseApplications),
    ...waterChangeEvents(tankData.id, tankData.maintenance),
    ...feedingEvents(tankData.id, tankData.feedings),
    ...additiveEvents(tankData.id, tankData.additives),
    ...fishEvents(tankData.id, tankData.livestock),
    ...systemEvents(tankData.id, tankData.events),
  ];

  return events
    .filter((event) => event.date)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.id).localeCompare(String(a.id)));
}

export function filterTimelineEvents(events, type) {
  return !type || type === "all" ? events : events.filter((event) => event.type === type);
}
