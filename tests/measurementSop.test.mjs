import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMeasurementSopSummary,
  convertMeasurementReading,
  getMeasurementSop,
  MEASUREMENT_SOP_ORDER,
  stepText,
} from "../modules/measurementSopModule.js";

test("Measurement SOP follows the preferred reef testing order", () => {
  assert.deepEqual(MEASUREMENT_SOP_ORDER, ["kh", "no3", "po4", "mg", "ca", "k"]);
});

test("Measurement SOP includes all six supported parameters and actionable steps", () => {
  for (const parameter of MEASUREMENT_SOP_ORDER) {
    const sop = getMeasurementSop(parameter);
    assert.ok(sop, parameter);
    assert.ok(sop.steps.length >= 5, parameter);
    assert.ok(sop.modes.length >= 1, parameter);
    assert.ok(stepText(sop.steps[0], sop.modes[0].value).length > 0, parameter);
  }
});

test("KH and CA low-resolution modes multiply the table reading by two", () => {
  const kh = convertMeasurementReading({ parameter: "kh", rawValue: 3.9, mode: "low-resolution" });
  const ca = convertMeasurementReading({ parameter: "ca", rawValue: 205, mode: "low-resolution" });

  assert.equal(kh.finalValue, 7.8);
  assert.equal(kh.formula, "原始讀值 × 2");
  assert.equal(ca.finalValue, 410);
  assert.equal(ca.formula, "原始讀值 × 2");
});

test("NO3 low-concentration mode divides by ten", () => {
  const result = convertMeasurementReading({
    parameter: "no3",
    rawValue: 5,
    mode: "low-concentration",
  });

  assert.equal(result.finalValue, 0.5);
  assert.equal(result.formula, "原始讀值 ÷ 10");
});

test("PO4 high-precision mode divides by two", () => {
  const result = convertMeasurementReading({
    parameter: "po4",
    rawValue: 0.08,
    mode: "high-precision",
  });

  assert.equal(result.finalValue, 0.04);
  assert.equal(result.formula, "原始讀值 ÷ 2");
});

test("NO3 uses side-view color matching while PO4 keeps top-down color matching", () => {
  const no3ReadingStep = getMeasurementSop("no3").steps.find((step) => step.title === "一般判讀");
  const po4ReadingStep = getMeasurementSop("po4").steps.find((step) => step.title === "判讀顏色");

  assert.match(stepText(no3ReadingStep, "standard"), /平視/);
  assert.doesNotMatch(stepText(no3ReadingStep, "standard"), /由上往下|俯視/);
  assert.match(stepText(po4ReadingStep, "standard"), /由上往下/);
});

test("MG and potassium keep user-entered ppm without invented conversion", () => {
  const mg = convertMeasurementReading({ parameter: "mg", rawValue: 1380, mode: "standard" });
  const potassium = convertMeasurementReading({ parameter: "k", rawValue: 410, mode: "standard" });

  assert.equal(mg.finalValue, 1380);
  assert.equal(potassium.finalValue, 410);
  assert.equal(potassium.formula, "依對照表輸入 ppm");
});

test("Measurement conversion rejects blank, invalid, and negative readings", () => {
  assert.ok(convertMeasurementReading({ parameter: "kh", rawValue: "", mode: "standard" }).error);
  assert.ok(convertMeasurementReading({ parameter: "kh", rawValue: "abc", mode: "standard" }).error);
  assert.ok(convertMeasurementReading({ parameter: "kh", rawValue: -1, mode: "standard" }).error);
});

test("Measurement SOP summary separates measured and skipped parameters", () => {
  const summary = buildMeasurementSopSummary({
    kh: { status: "measured", finalValue: 7.8 },
    no3: { status: "measured", finalValue: 1 },
    po4: { status: "skipped" },
    mg: { status: "skipped" },
    ca: { status: "measured", finalValue: 420 },
    k: { status: "skipped" },
  });

  assert.deepEqual(summary.measured, ["kh", "no3", "ca"]);
  assert.deepEqual(summary.skipped, ["po4", "mg", "k"]);
  assert.deepEqual(summary.pending, []);
  assert.deepEqual(summary.recommendationEligible, ["kh", "ca"]);
});

test("Skipped KH CA and MG never appear as recommendation eligible", () => {
  const summary = buildMeasurementSopSummary({
    kh: { status: "skipped" },
    ca: { status: "skipped" },
    mg: { status: "skipped" },
    no3: { status: "measured", finalValue: 1 },
    po4: { status: "measured", finalValue: 0.04 },
    k: { status: "measured", finalValue: 400 },
  });

  assert.deepEqual(summary.recommendationEligible, []);
});
