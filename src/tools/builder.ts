import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EngineClient } from "../engine.js";
import type { QrsClient } from "../qrs.js";
import type { Config } from "../config.js";
import {
  text, guid, VIZ_SPECS, checkVizShape, checkCellPlacement, redactSecrets,
  type VizFinding,
} from "./shared.js";
import { expressionWarnings, fieldNames } from "./quality.js";

// The UI-builder layer: create sheets and visualization objects, and — the
// part that makes it shippable — a validation gate that checks what the
// engine ACCEPTED will actually render. The engine happily persists a def the
// client draws as a blank tile; "saved" and "renders" are different claims.
const READ = { readOnlyHint: true, openWorldHint: false };

const positionSchema = z.object({
  col: z.number().int().min(0),
  row: z.number().int().min(0),
  colspan: z.number().int().positive(),
  rowspan: z.number().int().positive(),
}).describe("Grid cell (sheet grid is columns x rows, default 24x12)");

// ── Nebula default property blocks ───────────────────────────────────────────
// Modern Sense visualizations (barchart, linechart, piechart, scatterplot,
// treemap, combochart, gauge, table) are rendered by nebula.js supernovas
// (@nebula.js/sn-*), NOT by the engine. A hypercube the engine accepts and
// evaluates perfectly will still render BLANK if these property blocks are
// absent — the supernova throws `Cannot read properties of undefined
// (reading 'auto')` in the browser and the engine never knows.
//
// Verified live (May 2026 / sn-bar-chart 2.2.0) by building each type and
// screenshotting it through a headless browser: without these blocks 8 of 12
// types render blank; with them, all render. Extra properties a given
// supernova doesn't use are ignored, so one shared block is safe.
export const NEBULA_CHART_TYPES = new Set([
  "barchart", "linechart", "combochart", "piechart", "scatterplot", "table",
]);

const NEBULA_DEFAULTS: Record<string, any> = {
  showTitles: true, subtitle: "", footnote: "", showDetails: false, showDisclaimer: true,
  orientation: "vertical",
  barGrouping: { grouping: "grouped", grouping2: "grouped" },
  color: {
    auto: true, mode: "primary", formatting: { numFormatFromTemplate: true }, useBaseColors: "off",
    paletteColor: { index: 6 }, useDimColVal: true, useMeasureGradient: true, persistent: false,
    expressionIsColor: true, expressionLabel: "", measureScheme: "sg", reverseScheme: false,
    autoMinMax: true, measureMin: 0, measureMax: 10,
  },
  legend: { show: true, dock: "auto", showTitle: true, title: {} },
  dataPoint: { auto: true, showLabels: false, showSegmentLabels: false, showTotalLabels: false },
  gridLine: { auto: true, spacing: 2 },
  dimensionAxis: { show: "all", label: "auto", dock: "near", spacing: 1 },
  measureAxis: { show: "all", dock: "near", spacing: 1, autoMinMax: true, minMax: "min", min: 0, max: 10, label: "auto", logarithmic: false },
  xAxis: { show: "all", label: "auto", dock: "near", spacing: 1, autoMinMax: true, minMax: "min", min: 0, max: 10 },
  yAxis: { show: "all", label: "auto", dock: "near", spacing: 1, autoMinMax: true, minMax: "min", min: 0, max: 10 },
  tooltip: { auto: true },
  refLine: { refLines: [] },
  scrollStartPos: 0, scrollbar: "miniChart",
  totals: { show: true, position: "noTotals", label: "Totals" },
  usePagination: true,
};

// Per-supernova extras. Each was identified from the exact browser TypeError
// the chart throws without it (captured with a headless client), e.g.
// sn-pie-chart: "Cannot read properties of undefined (reading 'showAsDonut')".
const NEBULA_EXTRAS: Record<string, Record<string, any>> = {
  piechart: {
    donut: { showAsDonut: false, innerRadius: 50 },
    dataPoint: { auto: true, showLabels: true, showValues: false, showShares: false },
  },
  treemap: {
    // Harvested from a CLIENT-AUTHORED treemap in Qlik's shipped Content
    // Monitor app — not guessed. The block is FLAT BOOLEANS (and the key is
    // "leaves", not "leafs"); the nested {auto,show} shape an earlier version
    // guessed made sn-treemap render its error state.
    labels: { auto: true, headers: true, overlay: true, leaves: true, values: false },
    legend: { show: false, dock: "auto", showTitle: true },
  },

  scatterplot: {
    dataPoint: { auto: true, bubbleSizes: "auto", rangeBubbleSizes: [2, 8], showLabels: false },
    compressionResolution: "auto", navigation: false, colorMode: "primary",
    // scatter uses AXIS-SPECIFIC reference lines; the generic refLine.refLines
    // shape leaves it with nothing to iterate and it renders blank silently.
    refLine: { refLinesX: [], refLinesY: [] },
  },
};

/** Minimum tile the type needs to actually draw at sheet scale. */
const MIN_TILE: Record<string, { colspan: number; rowspan: number }> = {
  treemap: { colspan: 8, rowspan: 8 },
  scatterplot: { colspan: 8, rowspan: 6 },
  piechart: { colspan: 8, rowspan: 6 },
};

/** Dimension def with the fields nebula charts expect (cId, sort, attribute arrays). */
function nebulaDim(field: string, cId: string) {
  return {
    qDef: { qFieldDefs: [field], qSortCriterias: [{ qSortByLoadOrder: 1, qSortByNumeric: 1 }], autoSort: true, cId },
    qNullSuppression: false, qOtherTotalSpec: {}, qAttributeExpressions: [], qAttributeDimensions: [], cId,
  };
}

function nebulaMeasure(expr: string, cId: string) {
  return {
    qDef: { qDef: expr.startsWith("=") ? expr : `=${expr}`, qLabel: "", qNumFormat: { qType: "U" }, autoSort: true, cId, numFormatFromTemplate: true },
    qSortBy: { qSortByLoadOrder: 1, qSortByNumeric: -1 },
    qAttributeExpressions: [], qAttributeDimensions: [], cId, coloring: { auto: true },
  };
}

/** Build the per-type object properties for createChild. */
export function buildVizProps(
  viz: string,
  title: string | undefined,
  dimensions: string[],
  measures: Array<string>,
): Record<string, any> {
  const spec = VIZ_SPECS[viz];
  const base: Record<string, any> = { qInfo: { qType: viz }, visualization: viz, title: title ?? "" };
  if (spec?.cube === "listobject") {
    return {
      ...base,
      qListObjectDef: {
        qDef: { qFieldDefs: [dimensions[0]] },
        qInitialDataFetch: [{ qLeft: 0, qTop: 0, qWidth: 1, qHeight: 100 }],
      },
    };
  }
  if (spec?.cube === "none") {
    // text-image renders authored rich text. Embedding a live measure needs
    // the Sense client's own inline markup, which cannot be synthesized
    // reliably from here — an earlier attempt shipped literal "[Measure 1]"
    // placeholder text to users. So: render the given text, and take no
    // measures (VIZ_SPECS enforces maxMeasures 0). Use a kpi for a live value.
    return {
      ...base,
      markdown: title ?? "",
      showTitles: true, subtitle: "", footnote: "",
    };
  }
  if (viz === "treemap") {
    // Mirrored from a CLIENT-AUTHORED treemap (Qlik's Content Monitor app).
    // Two things the generic path got wrong: the cube must be qMode "K"
    // (tree mode — "S" renders Qlik's error state, the same class of trap as
    // pivot-table needing "P"), and the shared kitchen-sink property block
    // injects keys sn-treemap does not expect. Keep this lean and literal.
    return {
      ...base,
      showTitles: true, subtitle: "", footnote: "", showDetails: true,
      showDisclaimer: true, disableNavMenu: false,
      labels: { auto: true, headers: true, overlay: true, leaves: true, values: false },
      legend: { show: false, dock: "auto", showTitle: true },
      color: {
        auto: false, mode: "byDimension", formatting: { numFormatFromTemplate: true },
        useBaseColors: "off", paletteColor: { index: 6 }, useDimColVal: true,
        useMeasureGradient: true, persistent: false, expressionIsColor: true,
        expressionLabel: "", measureScheme: "sg", reverseScheme: false,
        autoMinMax: true, measureMin: 0, measureMax: 10,
      },
      tooltip: { auto: true, hideBasic: false, title: "", description: "" },
      qHyperCubeDef: {
        qDimensions: dimensions.map((d, i) => ({
          qDef: { qGrouping: "N", qFieldDefs: [d], qSortCriterias: [{ qSortByNumeric: 1, qSortByAscii: 1, qSortByLoadOrder: 1 }], autoSort: true, cId: `d${i + 1}`, othersLabel: "Others" },
          qOtherTotalSpec: {}, qAttributeExpressions: [], qAttributeDimensions: [],
        })),
        qMeasures: measures.map((m, i) => ({
          // client stores the expression WITHOUT a leading "="
          qDef: { qGrouping: "N", qDef: m.startsWith("=") ? m.slice(1) : m, qLabel: "", qNumFormat: { qType: "U" }, autoSort: true, cId: `m${i + 1}`, numFormatFromTemplate: true },
          qSortBy: { qSortByNumeric: -1, qSortByLoadOrder: 1 },
          qAttributeExpressions: [], qAttributeDimensions: [], qTrendLines: [],
        })),
        qInterColumnSortOrder: dimensions.map((_, i) => i).concat(measures.map((_, i) => dimensions.length + i)),
        qSuppressMissing: true,
        qInitialDataFetch: [{ qLeft: 0, qTop: 0, qWidth: 30, qHeight: 3000 }],
        qReductionMode: "N",
        qMode: "K",                 // tree mode — the actual fix
        qPseudoDimPos: -1, qNoOfLeftDims: -1, qAlwaysFullyExpanded: true,
        qMaxStackedCells: 3000, qShowTotalsAbove: true, qIndentMode: true,
        qSortbyYValue: -1, qColumnOrder: [],
      },
    };
  }
  if (viz === "gauge") {
    // Mirrored from a CLIENT-AUTHORED gauge (created in the Sense client for
    // exactly this purpose, then harvested). Guessing had failed three times
    // because the missing properties are ones no error message ever named:
    // `gaugetype` ("radial"), `angle`, `autoOrientation`, `paletteProgressColor`,
    // and `segmentInfo` — which earlier attempts had invented as `segments`.
    return {
      ...base,
      showTitles: true, subtitle: "", footnote: "", showDetails: true,
      showDetailsExpression: false, disableNavMenu: false, disclaimerClosed: true,
      gaugetype: "radial",
      angle: 0.7,
      autoOrientation: true,
      orientation: "horizontal",
      useSegments: false,
      segmentInfo: { limits: [], paletteColors: [{ index: 6 }] },
      paletteProgressColor: { index: 6 },
      color: { useBaseColors: "measure" },
      measureAxis: { min: 0, max: 100, show: "all", spacing: 1 },
      refLine: { refLines: [] },
      components: [],
      filter: null,
      qHyperCubeDef: {
        qDimensions: [],
        qMeasures: measures.map((m, i) => ({
          // client stores the expression WITHOUT a leading "="
          qDef: {
            qTags: [], qGrouping: "N", qDef: m.startsWith("=") ? m.slice(1) : m,
            qNumFormat: { qType: "U", qnDec: 10, qUseThou: 0 }, qAccumulate: 0,
            qActiveExpression: 0, qExpressions: [], autoSort: true,
            cId: `m${i + 1}`, numFormatFromTemplate: true,
          },
          qSortBy: { qSortByNumeric: -1, qSortByLoadOrder: 1 },
          qAttributeExpressions: [], qAttributeDimensions: [], qTrendLines: [],
        })),
        qInterColumnSortOrder: [0],
        qSuppressMissing: true,
        qInitialDataFetch: [{ qLeft: 0, qTop: 0, qWidth: 1, qHeight: 1 }],
        qReductionMode: "N", qMode: "S", qPseudoDimPos: -1, qNoOfLeftDims: -1,
        qMaxStackedCells: 5000, qColumnOrder: [],
      },
    };
  }
  const isNebula = NEBULA_CHART_TYPES.has(viz);
  const cube: Record<string, any> = {
    qDimensions: dimensions.map((d, i) => (isNebula ? nebulaDim(d, `d${i + 1}`) : { qDef: { qFieldDefs: [d] }, qNullSuppression: false })),
    qMeasures: measures.map((m, i) => (isNebula ? nebulaMeasure(m, `m${i + 1}`) : { qDef: { qDef: m.startsWith("=") ? m : `=${m}` } })),
    qInitialDataFetch: [{ qLeft: 0, qTop: 0, qWidth: Math.max(1, dimensions.length + measures.length), qHeight: 50 }],
    ...(isNebula ? {
      qSuppressZero: false, qSuppressMissing: true, qMode: "S",
      qInterColumnSortOrder: dimensions.map((_, i) => i).concat(measures.map((_, i) => dimensions.length + i)),
      // columnOrder must enumerate the columns — an empty array leaves
      // sn-table with headers but no columns (verified live).
      columnOrder: dimensions.concat(measures).map((_, i) => i),
      columnWidths: dimensions.concat(measures).map(() => -1),
    } : {}),
  };
  if (isNebula) Object.assign(base, NEBULA_DEFAULTS, NEBULA_EXTRAS[viz] ?? {});
  if (spec?.pivot) {
    // A pivot-table with a straight (default) cube saves fine and renders
    // EMPTY — the qMode:'P' requirement is exactly the kind of engine-accepts
    // client-breaks inconsistency the gate exists for.
    cube.qMode = "P";
    cube.qAlwaysFullyExpanded = true;
    cube.qNoOfLeftDims = dimensions.length;
    cube.qInitialDataFetch = [{ qLeft: 0, qTop: 0, qWidth: 10, qHeight: 50 }];
  }
  return { ...base, qHyperCubeDef: cube };
}

/** Validate one object's layout the way a renderer would consume it. */
async function validateObject(app: any, objectId: string, knownViz: Set<string>): Promise<{
  objectId: string; visualization?: string; title?: string;
  status: "pass" | "warn" | "fail"; findings: VizFinding[];
}> {
  const findings: VizFinding[] = [];
  let visualization: string | undefined;
  let title: string | undefined;
  try {
    const obj = await app.getObject(objectId);
    const prop = await obj.getProperties();
    visualization = prop.visualization ?? prop.qInfo?.qType;
    title = typeof prop.title === "string" ? prop.title : prop.qMetaDef?.title;

    if (visualization && !knownViz.has(visualization)) {
      findings.push({ severity: "fail", message: `visualization "${visualization}" is neither a built-in nor an installed extension — renders as "Invalid visualization"` });
    }

    const layout = await obj.getLayout();
    const hc = layout.qHyperCube;
    if (hc) {
      (hc.qDimensionInfo ?? []).forEach((d: any, i: number) => {
        if (d.qError) findings.push({ severity: "fail", message: `dimension ${i} error qErrorCode=${d.qError.qErrorCode} (${d.qFallbackTitle ?? "?"}) — check the field name` });
      });
      (hc.qMeasureInfo ?? []).forEach((m: any, i: number) => {
        if (m.qError) findings.push({ severity: "fail", message: `measure ${i} error qErrorCode=${m.qError.qErrorCode} (${m.qFallbackTitle ?? "?"}) — check the expression` });
      });
      if (hc.qSize && hc.qSize.qcy === 0 && (hc.qDimensionInfo?.length || hc.qMeasureInfo?.length)) {
        findings.push({ severity: "warn", message: "hypercube computes but returns 0 rows — renders as an empty chart under current selections/data" });
      }
      // Nebula supernovas throw on missing default property blocks and render
      // BLANK while the engine reports a perfectly healthy hypercube. Verified
      // live: without these, 8 of 12 built-in types draw nothing.
      if (visualization && NEBULA_CHART_TYPES.has(visualization)) {
        const props = await obj.getProperties();
        const missing = ["color", "legend", "dataPoint", "gridLine", "tooltip"].filter((k) => props[k] === undefined);
        if (missing.length) {
          findings.push({ severity: "fail", message: `${visualization} is nebula-rendered and is missing default property block(s): ${missing.join(", ")} — the engine computes it fine but the client throws and renders BLANK` });
        }
        const noCid = (props.qHyperCubeDef?.qMeasures ?? []).some((m: any) => !m.cId && !m.qDef?.cId);
        if (noCid) findings.push({ severity: "warn", message: "measures lack cId — some nebula charts need it for coloring/sorting" });
      }
      const vspec = visualization ? VIZ_SPECS[visualization] : undefined;
      if (vspec && vspec.renderVerified === false) {
        findings.push({ severity: "warn", message: `${visualization} is not render-verified: the engine accepts it and it evaluates, but it has not been proven to paint in a browser client with generically-built properties — check it visually before shipping it to users` });
      }
      const spec = visualization ? VIZ_SPECS[visualization] : undefined;
      if (spec?.pivot && hc.qMode !== "P" && hc.qMode !== "K") {
        findings.push({ severity: "fail", message: `pivot-table cube has qMode='${hc.qMode ?? "S"}' — must be 'P' (or 'K'); a straight cube renders an empty pivot` });
      }
      if (spec && spec.cube === "hypercube") {
        findings.push(...checkVizShape(visualization!, (hc.qDimensionInfo ?? []).length, (hc.qMeasureInfo ?? []).length));
      }
      // Expression-level validation on inline measure defs.
      const props = await obj.getProperties();
      for (const [i, m] of (props.qHyperCubeDef?.qMeasures ?? []).entries()) {
        const def: string | undefined = m?.qDef?.qDef;
        if (def) {
          for (const w of await expressionWarnings(app, def.startsWith("=") ? def.slice(1) : def)) {
            findings.push({ severity: "fail", message: `measure ${i}: ${w}` });
          }
        }
      }
    }
    const lo = layout.qListObject;
    if (lo?.qDimensionInfo?.qError) {
      findings.push({ severity: "fail", message: `listobject field error qErrorCode=${lo.qDimensionInfo.qError.qErrorCode}` });
    }
  } catch (e) {
    findings.push({ severity: "fail", message: `object unreadable: ${e instanceof Error ? e.message : String(e)}` });
  }
  const status = findings.some((f) => f.severity === "fail") ? "fail" : findings.length ? "warn" : "pass";
  return { objectId, visualization, title, status, findings };
}

async function knownVisualizations(qrs: QrsClient): Promise<Set<string>> {
  const known = new Set(Object.keys(VIZ_SPECS));
  // Sense client built-ins beyond the builder's supported set.
  for (const v of ["filterpane", "map", "histogram", "waterfallchart", "boxplot", "distributionplot", "mekkochart", "bulletchart", "sn-grid-chart", "action-button", "container", "qlik-word-cloud"]) known.add(v);
  try {
    const ext = await qrs.get<any[]>("/qrs/extension/full");
    for (const e of ext) known.add(e.name);
  } catch { /* extensions unavailable (e.g. narrow identity) — built-ins only */ }
  return known;
}

export function registerBuilderTools(server: McpServer, engine: EngineClient, qrs: QrsClient, cfg: Config): void {
  server.registerTool(
    "validate_sheet",
    {
      description:
        "Quality gate for the UI layer: validate that a sheet's objects (or one object) will actually render — " +
        "definition errors, unknown/missing visualization types, unknown fields in expressions, empty-data cubes, " +
        "pivot qMode traps, and cell-placement problems (unplaced objects, orphan cells, off-grid, overlaps). " +
        "The engine accepts definitions the client draws blank; this catches those before a user does.",
      inputSchema: {
        appId: guid.describe("App id (GUID)"),
        sheetId: z.string().optional().describe("Sheet to validate (all placed objects + placement lint)"),
        objectId: z.string().optional().describe("Single object to validate (placement lint skipped)"),
      },
      annotations: { ...READ, idempotentHint: true },
    },
    async ({ appId, sheetId, objectId }) => {
      if (!sheetId && !objectId) throw new Error("Provide sheetId or objectId");
      const app = await engine.app(appId);
      const known = await knownVisualizations(qrs);
      if (objectId) {
        return text(await validateObject(app, objectId, known));
      }
      const sheet = await app.getObject(sheetId!);
      const props = await sheet.getProperties();
      const children = (await sheet.getChildInfos()).map((c: any) => c.qId);
      const cells = (props.cells ?? []).map((c: any) => ({
        name: c.name, col: c.col ?? 0, row: c.row ?? 0, colspan: c.colspan ?? 1, rowspan: c.rowspan ?? 1,
      }));
      const placement = checkCellPlacement(cells, children, props.columns ?? 24, props.rows ?? 12);
      const objects = [];
      for (const id of children) objects.push(await validateObject(app, id, known));
      const failing = objects.filter((o) => o.status === "fail").length + placement.filter((f) => f.severity === "fail").length;
      return text({
        sheetId,
        grid: { columns: props.columns ?? 24, rows: props.rows ?? 12 },
        objectCount: children.length,
        verdict: failing ? "FAIL" : (placement.length || objects.some((o) => o.status === "warn")) ? "WARN" : "PASS",
        placementFindings: placement,
        objects,
      });
    },
  );

  if (!cfg.allowMutations) return;

  server.registerTool(
    "create_sheet",
    {
      description: "Create an empty sheet in an app. Returns the sheet id. MUTATION (additive).",
      inputSchema: {
        appId: guid.describe("App id (GUID)"),
        title: z.string().describe("Sheet title"),
        description: z.string().optional(),
        columns: z.number().int().positive().max(48).optional().describe("Grid columns (default 24)"),
        rows: z.number().int().positive().max(24).optional().describe("Grid rows (default 12)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ appId, title, description, columns, rows }) => {
      const app = await engine.app(appId);
      const sheet = await app.createObject({
        qInfo: { qType: "sheet" },
        qMetaDef: { title, description: description ?? "" },
        columns: columns ?? 24,
        rows: rows ?? 12,
        cells: [],
        qChildListDef: { qData: { title: "/title" } },
      });
      const sheetId = (await sheet.getLayout()).qInfo.qId;
      await app.doSave();
      return text({ sheetId, title, grid: { columns: columns ?? 24, rows: rows ?? 12 } });
    },
  );

  server.registerTool(
    "add_sheet_object",
    {
      description:
        "Add a visualization to a sheet and IMMEDIATELY run the render-validation gate on it — creation and " +
        "quality check in one call; the response's validation.status tells you whether it will actually render. " +
        `Supported types: ${Object.keys(VIZ_SPECS).join(", ")}. Dimensions are field names; measures are ` +
        "expressions. MUTATION (additive).",
      inputSchema: {
        appId: guid.describe("App id (GUID)"),
        sheetId: z.string().describe("Sheet id (from create_sheet or list_sheets)"),
        visualization: z.string().describe("Visualization type, e.g. 'barchart'"),
        title: z.string().optional(),
        dimensions: z.array(z.string()).optional().describe("Field names (default none)"),
        measures: z.array(z.string()).optional().describe("Measure expressions, e.g. 'Sum(Sales)' (default none)"),
        position: positionSchema.optional().describe("Omit to auto-place below existing cells"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ appId, sheetId, visualization, title, dimensions, measures, position }) => {
      const dims = dimensions ?? [];
      const meas = measures ?? [];
      // Pre-flight: shape + field existence. Fail BEFORE creating a broken
      // object rather than persisting junk and reporting it.
      const shape = checkVizShape(visualization, dims.length, meas.length);
      const hardShape = shape.filter((f) => f.severity === "fail");
      if (hardShape.length) throw new Error(`refusing to create: ${hardShape.map((f) => f.message).join("; ")}`);
      const app = await engine.app(appId);
      const fields = await fieldNames(app);
      const missing = dims.filter((d) => !fields.has(d));
      if (missing.length) throw new Error(`refusing to create: dimension field(s) not in the data model: ${missing.join(", ")}`);

      const sheet = await app.getObject(sheetId);
      const child = await sheet.createChild(buildVizProps(visualization, title, dims, meas));
      const objectId = (await child.getLayout()).qInfo.qId;

      const props = await sheet.getProperties();
      const cells = props.cells ?? [];
      const grid = { columns: props.columns ?? 24, rows: props.rows ?? 12 };
      let cell;
      if (position) {
        cell = { name: objectId, type: visualization, ...position };
      } else {
        // Auto-place: next free row band, 8x4 tiles, 3 per row.
        // Treemap refuses to draw ("This chart cannot be displayed") in a
        // short tile — it needs real estate. Verified live at sheet-tile
        // sizes, which is why auto-placement is per-type, not one-size.
        const n = cells.length;
        const span = MIN_TILE[visualization] ?? { colspan: 8, rowspan: 4 };
        cell = { name: objectId, type: visualization, col: (n % 3) * 8, row: Math.floor(n / 3) * 4, ...span };
      }
      // A cell below the grid renders NOTHING (caught by our own gate on the
      // first live matrix run — 14 auto-placed tiles overflowed the default
      // 12-row grid). Grow the sheet instead of silently placing off-grid.
      if (cell.row + cell.rowspan > grid.rows) {
        props.rows = cell.row + cell.rowspan;
        grid.rows = props.rows;
      }
      if (cell.col + cell.colspan > grid.columns) {
        props.columns = cell.col + cell.colspan;
        grid.columns = props.columns;
      }
      props.cells = [...cells, cell];
      await sheet.setProperties(props);
      await app.doSave();

      const known = await knownVisualizations(qrs);
      const validation = await validateObject(app, objectId, known);
      const placement = checkCellPlacement(
        props.cells.map((c: any) => ({ name: c.name, col: c.col ?? 0, row: c.row ?? 0, colspan: c.colspan ?? 1, rowspan: c.rowspan ?? 1 })),
        (await sheet.getChildInfos()).map((c: any) => c.qId),
        grid.columns, grid.rows,
      ).filter((f) => f.message.includes(objectId));
      return text(redactSecrets({ objectId, sheetId, cell, validation, placementFindings: placement }));
    },
  );
}
