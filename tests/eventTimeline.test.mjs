import assert from "node:assert/strict";
import test from "node:test";

import { buildTimelineEvents, filterTimelineEvents } from "../modules/eventTimelineModule.js";

function timelineTank() {
  return {
    id: "tank-1",
    records: [{
      id: "record-1",
      date: "2026-05-20",
      kh: 8.2,
      ca: 402,
      mg: 1350,
      no3: 1,
      po4: 0.04,
    }],
    doseApplications: [{
      id: "dose-1",
      appliedAt: "2026/5/21 12:00:00",
      label: "KH",
      parameter: "kh",
      oldDose: 6.6,
      newDose: 6.8,
      changeAmount: 0.2,
      relatedMeasurementId: "record-1",
      reason: "小幅調整",
    }],
    maintenance: [{
      id: "maintenance-1",
      date: "2026-05-19",
      waterChangeCount: 1,
      waterChangeVolume: 10,
    }],
    feedings: [{
      id: "feeding-1",
      date: "2026-05-18",
      amountLevel: "中",
      frequency: "每天 1 次",
      foodTypes: ["frozen-food"],
    }],
    additives: [{
      id: "additive-1",
      date: "2026-05-17",
      itemLabel: "Red Sea AB+",
      doseMl: 2,
      frequency: "單次",
    }],
    livestock: [{
      id: "fish-1",
      name: "小丑魚",
      quantity: 2,
      addedAt: "2026-05-16",
      removed: true,
      removedAt: "2026-05-22",
    }],
  };
}

test("Event timeline maps tracked tank activity to normalized event fields in descending date order", () => {
  const events = buildTimelineEvents(timelineTank());

  assert.deepEqual(events.map((event) => event.date), [
    "2026-05-22",
    "2026-05-21",
    "2026-05-20",
    "2026-05-19",
    "2026-05-18",
    "2026-05-17",
    "2026-05-16",
  ]);
  for (const event of events) {
    assert.ok(event.id);
    assert.equal(event.tankId, "tank-1");
    assert.ok(event.type);
    assert.ok(event.title);
    assert.ok(event.summary);
    assert.ok(Object.hasOwn(event, "relatedRecordId"));
    assert.ok(Object.hasOwn(event, "metadata"));
  }
  assert.equal(events.find((event) => event.type === "dosing-apply").relatedRecordId, "record-1");
});

test("Event timeline filter keeps only the selected event type", () => {
  const events = buildTimelineEvents(timelineTank());
  const fishEvents = filterTimelineEvents(events, "fish");

  assert.equal(fishEvents.length, 2);
  assert.ok(fishEvents.every((event) => event.type === "fish"));
  assert.equal(filterTimelineEvents(events, "all").length, events.length);
});
