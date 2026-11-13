// Pure-logic tests for the Qlik Cloud parity tools (no live site needed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cellValue, buildMeasureProps, buildDimensionProps } from "../dist/tools/parity.js";

test("cellValue: numeric, text, NaN, null", () => {
  assert.equal(cellValue({ qNum: 42, qText: "42" }), 42);
  assert.equal(cellValue({ qNum: "NaN", qText: "Vienna" }), "Vienna");
  assert.equal(cellValue({ qIsNull: true, qText: "-" }), null);
  assert.equal(cellValue({ qText: "x" }), "x");
});

test("buildMeasureProps strips leading = and defaults label to title", () => {
  const p = buildMeasureProps({ title: "Revenue", expression: "=Sum(Sales)" });
  assert.equal(p.qInfo.qType, "measure");
  assert.equal(p.qMeasure.qDef, "Sum(Sales)");
  assert.equal(p.qMeasure.qLabel, "Revenue");
  assert.deepEqual(p.qMetaDef, { title: "Revenue", description: "", tags: [] });
});

test("buildDimensionProps: single vs drill-down, rejects empty", () => {
  assert.equal(buildDimensionProps({ title: "Region", fields: ["Region"] }).qDim.qGrouping, "N");
  const drill = buildDimensionProps({ title: "Geo", fields: ["Country", "City"], label: "Geography" });
  assert.equal(drill.qDim.qGrouping, "H");
  assert.deepEqual(drill.qDim.qFieldLabels, ["Geography", ""]);
  assert.throws(() => buildDimensionProps({ title: "x", fields: [] }));
});

import { incrementDescription, buildScheduleBody, REPEAT_OPTIONS } from "../dist/tools/tasks.js";

test("incrementDescription splits minutes into 'min hour day week'", () => {
  assert.equal(incrementDescription(1440), "0 0 1 0");
  assert.equal(incrementDescription(90), "30 1 0 0");
  assert.equal(incrementDescription(10080 + 1440 + 61), "1 1 1 1");
  assert.equal(incrementDescription(-5), "0 0 0 0");
});

test("buildScheduleBody: QRS codes, open window, no operational key", () => {
  const b = buildScheduleBody({ taskId: "t", name: "n", repeat: "daily", intervalMinutes: 1440,
    startDate: "2026-12-01T03:00:00.000", timeZone: "Europe/Zurich", enabled: true });
  assert.equal(b.incrementOption, 2);
  assert.equal(REPEAT_OPTIONS.hourly, 1);
  assert.deepEqual(b.schemaFilterDescription, ["* * - * * * * *"]);
  assert.equal("operational" in b, false);
  assert.throws(() => buildScheduleBody({ ...b, taskId: "t", repeat: "daily", intervalMinutes: 60, timeWindow: "45 3-21 *" }));
  assert.throws(() => buildScheduleBody({ taskId: "t", name: "n", repeat: "hourly", intervalMinutes: 0, startDate: "x", timeZone: "z", enabled: true }));
});

import { interColumnSortOrder } from "../dist/tools/analyst.js";

test("interColumnSortOrder is a full permutation with the sort column first", () => {
  assert.deepEqual(interColumnSortOrder(4, 2), [2, 0, 1, 3]);
  assert.deepEqual(interColumnSortOrder(3, 2), [2, 0, 1]);
  assert.deepEqual(interColumnSortOrder(1, 0), [0]);
});
