import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EngineClient } from "../engine.js";
import type { Config } from "../config.js";
import { text, pageParams, paginate, guid } from "./shared.js";
import { expressionWarnings, activeSelections, fieldNames } from "./quality.js";

// Qlik Cloud MCP parity: tools the official Qlik Cloud MCP server ships
// (qlik_describe_app, qlik_search_field_values, qlik_get_chart_data,
// qlik_*_bookmark, qlik_create/update/delete_measure|dimension) that have a
// direct Engine API equivalent on QSEoW. Cloud-only surfaces (automations,
// glossary, data products, datasets, knowledge bases) have no on-prem
// counterpart and are intentionally absent.

const READ = { readOnlyHint: true, openWorldHint: false };
const SESSION_MUT = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const ADDITIVE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const EDIT = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
const DELETE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

const stripEq = (e: string) => (e.startsWith("=") ? e.slice(1) : e);

/** Engine cell -> plain value: number when the cell is numeric, else text. */
export function cellValue(c: any): string | number | null {
  if (c?.qIsNull) return null;
  if (c?.qNum !== undefined && c.qNum !== "NaN" && !Number.isNaN(c.qNum)) return c.qNum;
  return c?.qText ?? null;
}

/** Master measure properties (GenericMeasureProperties). */
export function buildMeasureProps(a: { title: string; expression: string; label?: string; description?: string; tags?: string[] }) {
  return {
    qInfo: { qType: "measure" },
    qMeasure: {
      qLabel: a.label ?? a.title,
      qDef: stripEq(a.expression),
      qGrouping: "N",
      qExpressions: [],
      qActiveExpression: 0,
    },
    qMetaDef: { title: a.title, description: a.description ?? "", tags: a.tags ?? [] },
  };
}

/** Master dimension properties. >1 field = drill-down group ("H"). */
export function buildDimensionProps(a: { title: string; fields: string[]; label?: string; description?: string; tags?: string[] }) {
  if (!a.fields.length) throw new Error("dimension needs at least one field");
  return {
    qInfo: { qType: "dimension" },
    qDim: {
      qGrouping: a.fields.length > 1 ? "H" : "N",
      qFieldDefs: a.fields,
      qFieldLabels: a.fields.map((_, i) => (i === 0 ? a.label ?? a.title : "")),
      title: a.title,
    },
    qMetaDef: { title: a.title, description: a.description ?? "", tags: a.tags ?? [] },
  };
}

/** Shallow-merge only the keys the caller passed (undefined = keep). */
function patch<T extends Record<string, any>>(target: T, changes: Record<string, unknown>): T {
  for (const [k, v] of Object.entries(changes)) if (v !== undefined) (target as any)[k] = v;
  return target;
}

async function listItems(app: any, def: Record<string, unknown>, key: string): Promise<any[]> {
  const obj = await app.createSessionObject({ qInfo: { qType: `mcp-parity-${key}` }, ...def });
  try {
    const layout = await obj.getLayout();
    return layout[key]?.qItems ?? [];
  } finally {
    await app.destroySessionObject(obj.id).catch(() => {});
  }
}

export function registerParityTools(server: McpServer, engine: EngineClient, cfg: Config) {
  server.registerTool(
    "describe_app",
    {
      description:
        "One-call overview of an app: title, last reload, tables (rows/field counts), sheets, master measure/dimension " +
        "counts, variables and bookmarks. Start here before querying an unfamiliar app.",
      inputSchema: { appId: guid.describe("App id (GUID)") },
      annotations: READ,
    },
    async ({ appId }) => {
      const app = await engine.app(appId);
      const layout = await app.getAppLayout();
      const tk = await app.getTablesAndKeys({ qcx: 1000, qcy: 1000 }, { qcx: 0, qcy: 0 }, 30, true, false);
      const [sheets, measures, dims, vars, bookmarks] = await Promise.all([
        listItems(app, { qAppObjectListDef: { qType: "sheet", qData: {} } }, "qAppObjectList"),
        listItems(app, { qMeasureListDef: { qType: "measure" } }, "qMeasureList"),
        listItems(app, { qDimensionListDef: { qType: "dimension" } }, "qDimensionList"),
        listItems(app, { qVariableListDef: { qType: "variable" } }, "qVariableList"),
        listItems(app, { qBookmarkListDef: { qType: "bookmark" } }, "qBookmarkList"),
      ]);
      const tables = (tk.qtr ?? []).map((t: any) => ({ name: t.qName, rows: t.qNoOfRows, fields: (t.qFields ?? []).length }));
      return text({
        appId,
        title: layout.qTitle,
        description: layout.description,
        lastReload: layout.qLastReloadTime,
        published: layout.published,
        tables,
        totalFields: tables.reduce((n: number, t: any) => n + t.fields, 0),
        sheets: sheets.map((s: any) => ({ sheetId: s.qInfo.qId, title: s.qMeta?.title, published: s.qMeta?.published })),
        masterMeasures: measures.length,
        masterDimensions: dims.length,
        variables: vars.length,
        bookmarks: bookmarks.length,
      });
    },
  );

  server.registerTool(
    "search_field_values",
    {
      description:
        "Search a term across ALL fields of an app (or a given subset) and return which fields contain matching " +
        "values. Use when you know a value (a customer, product, region) but not which field holds it.",
      inputSchema: {
        appId: guid.describe("App id (GUID)"),
        terms: z.array(z.string()).min(1).describe("Search terms, e.g. ['Vienna']"),
        fields: z.array(z.string()).optional().describe("Restrict to these fields (default: all)"),
        maxMatchesPerField: z.number().int().positive().max(100).optional().describe("Default 10"),
        maxFields: z.number().int().positive().max(100).optional().describe("Default 20"),
      },
      annotations: READ,
    },
    async ({ appId, terms, fields, maxMatchesPerField, maxFields }) => {
      const app = await engine.app(appId);
      const per = maxMatchesPerField ?? 10;
      const r = await app.searchResults(
        { qSearchFields: fields ?? [], qContext: "Cleared" },
        terms,
        { qOffset: 0, qCount: maxFields ?? 20, qMaxNbrFieldMatches: per, qGroupOptions: [], qGroupItemOptions: [] },
      );
      const matches = (r.qSearchGroupArray ?? []).flatMap((g: any) =>
        (g.qItems ?? []).map((it: any) => ({
          field: it.qIdentifier,
          totalMatches: it.qTotalNumberOfMatches,
          values: (it.qItemMatches ?? []).map((m: any) => m.qText),
        })),
      );
      return text({ terms, fieldCount: matches.length, totalGroups: r.qTotalNumberOfGroups, matches });
    },
  );

  server.registerTool(
    "get_chart_data",
    {
      description:
        "Fetch the DATA an existing sheet object shows (hypercube or listbox), honoring current selections — " +
        "column headers + rows. Use get_sheet_objects to find object ids. Pivot tables return their straight-table " +
        "form via the stacked page.",
      inputSchema: {
        appId: guid.describe("App id (GUID)"),
        objectId: z.string().describe("Object id (from get_sheet_objects)"),
        maxRows: z.number().int().positive().max(10000).optional().describe("Row limit (default 200)"),
      },
      annotations: READ,
    },
    async ({ appId, objectId, maxRows }) => {
      const app = await engine.app(appId);
      const obj = await app.getObject(objectId);
      const layout = await obj.getLayout();
      const limit = maxRows ?? 200;
      const base = { objectId, visualization: layout.visualization ?? layout.qInfo?.qType, title: layout.title };

      if (layout.qListObject) {
        const lo = layout.qListObject;
        const pages = await obj.getListObjectData("/qListObjectDef", [{ qTop: 0, qLeft: 0, qWidth: 1, qHeight: limit }]);
        return text({
          ...base,
          kind: "listobject",
          field: lo.qDimensionInfo?.qFallbackTitle,
          cardinality: lo.qDimensionInfo?.qCardinal,
          values: (pages?.[0]?.qMatrix ?? []).map((r: any[]) => ({ value: cellValue(r[0]), state: r[0].qState })),
          activeSelections: await activeSelections(app),
        });
      }

      const cube = layout.qHyperCube;
      if (!cube) {
        const children = (layout.qChildList?.qItems ?? []).map((c: any) => ({ objectId: c.qInfo.qId, qType: c.qInfo.qType }));
        return text({ ...base, kind: "none", note: "object holds no data; query its children instead", children });
      }

      const columns = [
        ...(cube.qDimensionInfo ?? []).map((d: any) => d.qFallbackTitle),
        ...(cube.qMeasureInfo ?? []).map((m: any) => m.qFallbackTitle),
      ];
      const width = Math.max(columns.length, 1);
      // Engine caps a single page at 10,000 cells.
      const height = Math.min(limit, Math.floor(10000 / width));
      let rows: Array<Array<string | number | null>>;
      let mode = cube.qMode;
      if (cube.qMode === "P") {
        const p = await obj.getHyperCubeStackData("/qHyperCubeDef", [{ qTop: 0, qLeft: 0, qWidth: width, qHeight: height }], 10000);
        // Stack data is a tree; flatten leaves to dimension paths + values.
        rows = [];
        const walk = (n: any, path: string[]) => {
          const here = n.qText !== undefined && n.qType !== "R" ? [...path, n.qText] : path;
          if (!n.qSubNodes?.length) rows.push([...here, n.qValue ?? null]);
          else for (const s of n.qSubNodes) walk(s, here);
        };
        for (const page of p ?? []) for (const n of page.qData ?? []) walk(n, []);
        rows = rows.slice(0, limit);
        mode = "P (stacked)";
      } else {
        const pages = await obj.getHyperCubeData("/qHyperCubeDef", [{ qTop: 0, qLeft: 0, qWidth: width, qHeight: height }]);
        rows = (pages?.[0]?.qMatrix ?? []).map((r: any[]) => r.map(cellValue));
      }
      return text({
        ...base,
        kind: "hypercube",
        mode,
        columns,
        totalRows: cube.qSize?.qcy,
        returnedRows: rows.length,
        rows,
        activeSelections: await activeSelections(app),
      });
    },
  );

  server.registerTool(
    "list_bookmarks",
    {
      description: "List the app's bookmarks: id, title, description, created date, published state. Paged.",
      inputSchema: { appId: guid.describe("App id (GUID)"), ...pageParams },
      annotations: READ,
    },
    async ({ appId, offset, limit }) => {
      const app = await engine.app(appId);
      const items = await listItems(
        app,
        { qBookmarkListDef: { qType: "bookmark", qData: { title: "/qMetaDef/title", description: "/qMetaDef/description" } } },
        "qBookmarkList",
      );
      return text(paginate(items.map((b: any) => ({
        bookmarkId: b.qInfo.qId,
        title: b.qMeta?.title ?? b.qData?.title,
        description: b.qMeta?.description ?? b.qData?.description,
        created: b.qMeta?.createdDate,
        published: b.qMeta?.published,
        owner: b.qMeta?.owner?.name,
      })), offset, limit));
    },
  );

  server.registerTool(
    "apply_bookmark",
    {
      description: "Apply a bookmark's selections to this MCP session (session-scoped, nothing persisted). Returns the resulting selections.",
      inputSchema: { appId: guid.describe("App id (GUID)"), bookmarkId: z.string().describe("Bookmark id (from list_bookmarks)") },
      annotations: SESSION_MUT,
    },
    async ({ appId, bookmarkId }) => {
      const app = await engine.app(appId);
      const ok = await app.applyBookmark(bookmarkId);
      if (!ok) throw new Error(`engine refused to apply bookmark ${bookmarkId}`);
      return text({ bookmarkId, applied: true, activeSelections: await activeSelections(app) });
    },
  );

  // Persisted mutations: registered only when mutations are enabled, same
  // contract as the rest of the server.
  if (!cfg.allowMutations) return;

  server.registerTool(
    "create_bookmark",
    {
      description: "Save the session's CURRENT selections as a bookmark (use select_field_values first). MUTATION (additive).",
      inputSchema: {
        appId: guid.describe("App id (GUID)"),
        title: z.string().min(1),
        description: z.string().optional(),
      },
      annotations: ADDITIVE,
    },
    async ({ appId, title, description }) => {
      const app = await engine.app(appId);
      const selections = await activeSelections(app);
      const bm = await app.createBookmark({
        qInfo: { qType: "bookmark" },
        qMetaDef: { title, description: description ?? "" },
        creationDate: new Date().toISOString(),
      });
      const bookmarkId = (await bm.getLayout()).qInfo.qId;
      await app.doSave();
      return text({ bookmarkId, title, capturedSelections: selections });
    },
  );

  server.registerTool(
    "delete_bookmark",
    {
      description: "Delete a bookmark. MUTATION (destructive).",
      inputSchema: { appId: guid.describe("App id (GUID)"), bookmarkId: z.string() },
      annotations: DELETE,
    },
    async ({ appId, bookmarkId }) => {
      const app = await engine.app(appId);
      if (!(await app.destroyBookmark(bookmarkId))) throw new Error(`bookmark ${bookmarkId} not found or not deletable`);
      await app.doSave();
      return text({ bookmarkId, deleted: true });
    },
  );

  const itemMeta = {
    label: z.string().optional().describe("Display label (default: title)"),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
  };

  server.registerTool(
    "create_master_measure",
    {
      description: "Create a governed master measure. The expression is engine-validated first; unknown fields refuse creation. MUTATION (additive).",
      inputSchema: { appId: guid.describe("App id (GUID)"), title: z.string().min(1), expression: z.string().min(1).describe("e.g. Sum(Sales)"), ...itemMeta },
      annotations: ADDITIVE,
    },
    async ({ appId, title, expression, label, description, tags }) => {
      const app = await engine.app(appId);
      const warnings = await expressionWarnings(app, stripEq(expression));
      if (warnings.length) throw new Error(`refusing to create: ${warnings.join("; ")}`);
      const m = await app.createMeasure(buildMeasureProps({ title, expression, label, description, tags }));
      const measureId = (await m.getLayout()).qInfo.qId;
      await app.doSave();
      return text({ measureId, title, expression: stripEq(expression) });
    },
  );

  server.registerTool(
    "update_master_measure",
    {
      description: "Update a master measure's title, expression, label, description or tags (omitted = unchanged). MUTATION.",
      inputSchema: {
        appId: guid.describe("App id (GUID)"),
        measureId: z.string(),
        title: z.string().optional(),
        expression: z.string().optional(),
        ...itemMeta,
      },
      annotations: EDIT,
    },
    async ({ appId, measureId, title, expression, label, description, tags }) => {
      const app = await engine.app(appId);
      if (expression) {
        const warnings = await expressionWarnings(app, stripEq(expression));
        if (warnings.length) throw new Error(`refusing to update: ${warnings.join("; ")}`);
      }
      const m = await app.getMeasure(measureId);
      const props = await m.getProperties();
      patch(props.qMeasure, { qDef: expression && stripEq(expression), qLabel: label });
      props.qMetaDef = patch(props.qMetaDef ?? {}, { title, description, tags });
      await m.setProperties(props);
      await app.doSave();
      return text({ measureId, updated: true, title: props.qMetaDef.title, expression: props.qMeasure.qDef });
    },
  );

  server.registerTool(
    "delete_master_measure",
    {
      description: "Delete a master measure. Charts that link to it lose their measure. MUTATION (destructive).",
      inputSchema: { appId: guid.describe("App id (GUID)"), measureId: z.string() },
      annotations: DELETE,
    },
    async ({ appId, measureId }) => {
      const app = await engine.app(appId);
      if (!(await app.destroyMeasure(measureId))) throw new Error(`measure ${measureId} not found or not deletable`);
      await app.doSave();
      return text({ measureId, deleted: true });
    },
  );

  server.registerTool(
    "create_master_dimension",
    {
      description: "Create a master dimension. One field = single dimension; several = drill-down group (in drill order). Fields must exist in the data model. MUTATION (additive).",
      inputSchema: { appId: guid.describe("App id (GUID)"), title: z.string().min(1), fields: z.array(z.string()).min(1), ...itemMeta },
      annotations: ADDITIVE,
    },
    async ({ appId, title, fields, label, description, tags }) => {
      const app = await engine.app(appId);
      const known = await fieldNames(app);
      // Calculated dimensions (=...) are not plain field names; let the engine judge those.
      const missing = fields.filter((f) => !f.startsWith("=") && !known.has(f));
      if (missing.length) throw new Error(`refusing to create: field(s) not in the data model: ${missing.join(", ")}`);
      const d = await app.createDimension(buildDimensionProps({ title, fields, label, description, tags }));
      const dimensionId = (await d.getLayout()).qInfo.qId;
      await app.doSave();
      return text({ dimensionId, title, fields, grouping: fields.length > 1 ? "drill-down" : "single" });
    },
  );

  server.registerTool(
    "update_master_dimension",
    {
      description: "Update a master dimension's title, fields, label, description or tags (omitted = unchanged). MUTATION.",
      inputSchema: {
        appId: guid.describe("App id (GUID)"),
        dimensionId: z.string(),
        title: z.string().optional(),
        fields: z.array(z.string()).min(1).optional(),
        ...itemMeta,
      },
      annotations: EDIT,
    },
    async ({ appId, dimensionId, title, fields, label, description, tags }) => {
      const app = await engine.app(appId);
      const d = await app.getDimension(dimensionId);
      const props = await d.getProperties();
      if (fields) {
        props.qDim.qFieldDefs = fields;
        props.qDim.qGrouping = fields.length > 1 ? "H" : "N";
        props.qDim.qFieldLabels = fields.map((_: string, i: number) => props.qDim.qFieldLabels?.[i] ?? "");
      }
      if (label !== undefined) props.qDim.qFieldLabels = [label, ...(props.qDim.qFieldLabels ?? []).slice(1)];
      if (title !== undefined) props.qDim.title = title;
      props.qMetaDef = patch(props.qMetaDef ?? {}, { title, description, tags });
      await d.setProperties(props);
      await app.doSave();
      return text({ dimensionId, updated: true, title: props.qMetaDef.title, fields: props.qDim.qFieldDefs });
    },
  );

  server.registerTool(
    "delete_master_dimension",
    {
      description: "Delete a master dimension. Charts that link to it lose their dimension. MUTATION (destructive).",
      inputSchema: { appId: guid.describe("App id (GUID)"), dimensionId: z.string() },
      annotations: DELETE,
    },
    async ({ appId, dimensionId }) => {
      const app = await engine.app(appId);
      if (!(await app.destroyDimension(dimensionId))) throw new Error(`dimension ${dimensionId} not found or not deletable`);
      await app.doSave();
      return text({ dimensionId, deleted: true });
    },
  );
}
