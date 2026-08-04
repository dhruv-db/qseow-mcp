import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EngineClient } from "../engine.js";

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });

export function registerAnalystTools(server: McpServer, engine: EngineClient): void {
  server.tool(
    "list_engine_apps",
    "List apps visible to the current engine session (id, name, last reload).",
    {},
    async () => {
      const g = await engine.global();
      const docs = await g.getDocList();
      return text(docs.map((d: any) => ({
        id: d.qDocId, name: d.qDocName, lastReload: d.qLastReloadTime, fileSizeBytes: d.qFileSize,
      })));
    },
  );

  server.tool(
    "get_app_data_model",
    "Tables and fields of an app's data model — the map an analyst needs before querying.",
    { appId: z.string().describe("App id (GUID)") },
    async ({ appId }) => {
      const app = await engine.app(appId);
      const layout = await app.getAppLayout();
      const tk = await app.getTablesAndKeys({ qcx: 1000, qcy: 1000 }, { qcx: 0, qcy: 0 }, 30, true, false);
      return text({
        title: layout.qTitle,
        lastReload: layout.qLastReloadTime,
        tables: (tk.qtr ?? []).map((t: any) => ({
          name: t.qName,
          rows: t.qNoOfRows,
          fields: (t.qFields ?? []).map((f: any) => ({
            name: f.qName, cardinality: f.qnPresentDistinctValues, tags: f.qTags,
          })),
        })),
      });
    },
  );

  server.tool(
    "evaluate_expression",
    "Evaluate a Qlik expression against an app in the current selection state, e.g. \"Sum(Sales)\" or \"Count(distinct Customer)\".",
    {
      appId: z.string().describe("App id (GUID)"),
      expression: z.string().describe("Qlik expression without leading ="),
    },
    async ({ appId, expression }) => {
      const app = await engine.app(appId);
      const r = await app.evaluateEx(expression);
      return text({ expression, value: r.qText ?? r.qNumber, isNumeric: r.qIsNumeric });
    },
  );

  server.tool(
    "create_hypercube",
    "Build a hypercube (group-by query) over an app: dimensions + measure expressions, returns tabular data honoring current selections. The core analyst query tool.",
    {
      appId: z.string().describe("App id (GUID)"),
      dimensions: z.array(z.string()).describe("Field names or dimension expressions"),
      measures: z.array(z.string()).describe("Measure expressions, e.g. 'Sum(Sales)'"),
      maxRows: z.number().int().positive().max(10000).optional().describe("Row limit (default 200)"),
      sortByMeasureDesc: z.number().int().optional().describe("Sort by measure index (0-based), descending"),
    },
    async ({ appId, dimensions, measures, maxRows, sortByMeasureDesc }) => {
      const app = await engine.app(appId);
      const limit = maxRows ?? 200;
      const width = dimensions.length + measures.length;
      const def: any = {
        qInfo: { qType: "mcp-hypercube" },
        qHyperCubeDef: {
          qDimensions: dimensions.map((d) => ({
            qDef: { qFieldDefs: [d.startsWith("=") ? d : d] },
            qNullSuppression: false,
          })),
          qMeasures: measures.map((m) => ({ qDef: { qDef: m.startsWith("=") ? m : `=${m}` } })),
          qInitialDataFetch: [{ qLeft: 0, qTop: 0, qWidth: width, qHeight: Math.min(limit, Math.floor(10000 / Math.max(width, 1))) }],
          ...(sortByMeasureDesc !== undefined
            ? { qInterColumnSortOrder: [dimensions.length + sortByMeasureDesc, ...Array.from({ length: width - 1 }, (_, i) => i).filter((i) => i !== dimensions.length + sortByMeasureDesc)] }
            : {}),
        },
      };
      if (sortByMeasureDesc !== undefined) {
        def.qHyperCubeDef.qMeasures[sortByMeasureDesc].qSortBy = { qSortByNumeric: -1 };
      }
      const obj = await app.createSessionObject(def);
      try {
        const layout = await obj.getLayout();
        const cube = layout.qHyperCube;
        const page = cube.qDataPages?.[0];
        const rows = (page?.qMatrix ?? []).map((r: any[]) =>
          r.map((c) => (c.qNum !== undefined && c.qNum !== "NaN" && !Number.isNaN(c.qNum) ? c.qNum : c.qText)),
        );
        return text({
          columns: [...dimensions, ...measures],
          totalRows: cube.qSize?.qcy,
          returnedRows: rows.length,
          rows,
        });
      } finally {
        await app.destroySessionObject(obj.id).catch(() => {});
      }
    },
  );

  server.tool(
    "get_field_values",
    "List distinct values of a field with selection state (S=selected, O=optional, X=excluded). Optional search term.",
    {
      appId: z.string().describe("App id (GUID)"),
      field: z.string().describe("Field name"),
      maxValues: z.number().int().positive().max(1000).optional().describe("Limit (default 100)"),
      searchTerm: z.string().optional().describe("Search within values"),
    },
    async ({ appId, field, maxValues, searchTerm }) => {
      const app = await engine.app(appId);
      const limit = maxValues ?? 100;
      const obj = await app.createSessionObject({
        qInfo: { qType: "mcp-listobject" },
        qListObjectDef: {
          qDef: { qFieldDefs: [field] },
          qInitialDataFetch: [{ qLeft: 0, qTop: 0, qWidth: 1, qHeight: limit }],
        },
      });
      try {
        if (searchTerm) {
          await obj.searchListObjectFor("/qListObjectDef", searchTerm);
        }
        const layout = await obj.getLayout();
        const page = layout.qListObject.qDataPages?.[0];
        return text({
          field,
          cardinality: layout.qListObject.qDimensionInfo?.qCardinal,
          values: (page?.qMatrix ?? []).map((r: any[]) => ({ value: r[0].qText, state: r[0].qState })),
        });
      } finally {
        await app.destroySessionObject(obj.id).catch(() => {});
      }
    },
  );

  server.tool(
    "select_field_values",
    "Select values in a field (session-scoped; affects subsequent hypercubes/expressions in this MCP session).",
    {
      appId: z.string().describe("App id (GUID)"),
      field: z.string().describe("Field name"),
      values: z.array(z.string()).describe("Values to select"),
      toggle: z.boolean().optional().describe("Toggle instead of replace (default false)"),
    },
    async ({ appId, field, values, toggle }) => {
      const app = await engine.app(appId);
      const f = await app.getField(field);
      const ok = await f.selectValues(values.map((v) => ({ qText: v })), toggle ?? false, false);
      return text({ field, selected: values, applied: ok });
    },
  );

  server.tool(
    "get_current_selections",
    "Current selection state across all fields in the session.",
    { appId: z.string().describe("App id (GUID)") },
    async ({ appId }) => {
      const app = await engine.app(appId);
      const obj = await app.createSessionObject({
        qInfo: { qType: "mcp-selections" },
        qSelectionObjectDef: {},
      });
      try {
        const layout = await obj.getLayout();
        return text((layout.qSelectionObject?.qSelections ?? []).map((s: any) => ({
          field: s.qField, selectedCount: s.qSelectedCount, selected: s.qSelected,
        })));
      } finally {
        await app.destroySessionObject(obj.id).catch(() => {});
      }
    },
  );

  server.tool(
    "clear_selections",
    "Clear selections in one field or all fields.",
    {
      appId: z.string().describe("App id (GUID)"),
      field: z.string().optional().describe("Field to clear; omit to clear all"),
    },
    async ({ appId, field }) => {
      const app = await engine.app(appId);
      if (field) {
        const f = await app.getField(field);
        await f.clear();
        return text(`Cleared selections in ${field}`);
      }
      await app.clearAll();
      return text("Cleared all selections");
    },
  );
}
