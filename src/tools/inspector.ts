import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EngineClient } from "../engine.js";
import { text, pageParams, paginate } from "./shared.js";

// The troubleshooting loop: KPI -> object -> sheet -> app -> script -> source.
// Everything here is read-only introspection of a single app's definition
// layer — the part of a Qlik estate a support engineer actually walks when a
// number is wrong.
const READ = { readOnlyHint: true, openWorldHint: false };

async function sheetList(app: any): Promise<Array<{ sheetId: string; title: string; published: boolean }>> {
  const obj = await app.createSessionObject({
    qInfo: { qType: "mcp-sheetlist" },
    qAppObjectListDef: {
      qType: "sheet",
      qData: { title: "/qMetaDef.title" },
    },
  });
  try {
    const layout = await obj.getLayout();
    return (layout.qAppObjectList?.qItems ?? []).map((s: any) => ({
      sheetId: s.qInfo.qId,
      title: s.qMeta?.title ?? s.qData?.title ?? "",
      published: Boolean(s.qMeta?.published),
    }));
  } finally {
    await app.destroySessionObject(obj.id).catch(() => {});
  }
}

/** sheetId -> {title}; objectId -> owning sheet. Built once per call that
 *  needs ownership annotation. */
async function objectToSheetMap(app: any): Promise<Map<string, { sheetId: string; sheetTitle: string }>> {
  const map = new Map<string, { sheetId: string; sheetTitle: string }>();
  for (const s of await sheetList(app)) {
    try {
      const sheet = await app.getObject(s.sheetId);
      for (const c of await sheet.getChildInfos()) {
        map.set(c.qId, { sheetId: s.sheetId, sheetTitle: s.title });
      }
    } catch { /* sheet unreadable — skip */ }
  }
  return map;
}

/** Walk any JSON value; call visit(path, string) on every string leaf. */
function walkStrings(v: unknown, path: string, visit: (path: string, s: string) => void): void {
  if (typeof v === "string") {
    visit(path, v);
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => walkStrings(x, `${path}[${i}]`, visit));
  } else if (v !== null && typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      walkStrings(val, path ? `${path}.${k}` : k, visit);
    }
  }
}

export function registerInspectorTools(server: McpServer, engine: EngineClient): void {
  server.registerTool(
    "list_sheets",
    {
      description: "List an app's sheets with id, title, and published state. The entry point for walking an app's UI layer.",
      inputSchema: { appId: z.string().describe("App id (GUID)") },
      annotations: READ,
    },
    async ({ appId }) => {
      const app = await engine.app(appId);
      return text(await sheetList(app));
    },
  );

  server.registerTool(
    "get_sheet_objects",
    {
      description: "List the visualization objects on a sheet: id, type, visualization, and title. The sheet -> object step of a KPI trace.",
      inputSchema: {
        appId: z.string().describe("App id (GUID)"),
        sheetId: z.string().describe("Sheet id (from list_sheets)"),
      },
      annotations: READ,
    },
    async ({ appId, sheetId }) => {
      const app = await engine.app(appId);
      const sheet = await app.getObject(sheetId);
      const children = await sheet.getChildInfos();
      const out = [];
      for (const c of children) {
        let title: string | undefined;
        let visualization: string | undefined;
        try {
          const child = await app.getObject(c.qId);
          const prop = await child.getProperties();
          visualization = prop.visualization;
          title = typeof prop.title === "string" ? prop.title
            : prop.title?.qStringExpression?.qExpr ?? prop.qMetaDef?.title;
        } catch { /* keep id+type only */ }
        out.push({ objectId: c.qId, qType: c.qType, visualization, title });
      }
      return text({ sheetId, objects: out });
    },
  );

  server.registerTool(
    "get_object_properties",
    {
      description: "Full property tree (qProps) of any object — the definition layer: measures, dimensions, expressions, extension config. The object -> definition step of a KPI trace.",
      inputSchema: {
        appId: z.string().describe("App id (GUID)"),
        objectId: z.string().describe("Object id (from get_sheet_objects or search_expressions)"),
      },
      annotations: READ,
    },
    async ({ appId, objectId }) => {
      const app = await engine.app(appId);
      const obj = await app.getObject(objectId);
      return text(await obj.getProperties());
    },
  );

  server.registerTool(
    "search_expressions",
    {
      description: "Find where an expression fragment, field, or KPI term is used across an ENTIRE app: every object's properties (with owning sheet), master measures/dimensions, variables, and the load script. The 'where does this number come from' tool. NOTE: on a PUBLISHED app the engine hides the load script from user identities, so script matches only appear for unpublished apps you own — copy_app the target and search the copy to include script hits.",
      inputSchema: {
        appId: z.string().describe("App id (GUID)"),
        term: z.string().min(2).describe("Search term, e.g. a field name, measure label, or expression fragment"),
        caseSensitive: z.boolean().optional().describe("Default false"),
        maxMatches: z.number().int().positive().max(500).optional().describe("Cap on returned matches (default 100)"),
      },
      annotations: READ,
    },
    async ({ appId, term, caseSensitive, maxMatches }) => {
      const app = await engine.app(appId);
      const needle = caseSensitive ? term : term.toLowerCase();
      const cap = maxMatches ?? 100;
      const matches: any[] = [];
      let truncated = false;

      const snippet = (s: string) => {
        const hay = caseSensitive ? s : s.toLowerCase();
        const i = hay.indexOf(needle);
        const start = Math.max(0, i - 60);
        return (start > 0 ? "…" : "") + s.slice(start, i + term.length + 60) + (i + term.length + 60 < s.length ? "…" : "");
      };
      const hit = (where: Record<string, unknown>, path: string, s: string) => {
        if (matches.length >= cap) { truncated = true; return; }
        const hay = caseSensitive ? s : s.toLowerCase();
        if (hay.includes(needle) && s.length < 50_000) {
          matches.push({ ...where, path, snippet: snippet(s) });
        }
      };

      // 1. every app object's full properties, annotated with owning sheet
      const sheetOf = await objectToSheetMap(app);
      const infos = await app.getAllInfos();
      let objectsScanned = 0;
      for (const info of infos) {
        if (matches.length >= cap) { truncated = true; break; }
        try {
          const obj = await app.getObject(info.qId);
          const prop = await obj.getProperties();
          objectsScanned++;
          const owner = sheetOf.get(info.qId);
          walkStrings(prop, "", (path, s) =>
            hit({ kind: "object", objectId: info.qId, qType: info.qType, ...(owner ?? {}) }, path, s));
        } catch { /* not a generic object (fields, etc.) — skip */ }
      }

      // 2. master measures + dimensions (their defs live outside object props)
      for (const [listDef, listKey, kind] of [
        [{ qMeasureListDef: { qType: "measure", qData: { def: "/qMeasure" } } }, "qMeasureList", "master_measure"],
        [{ qDimensionListDef: { qType: "dimension", qData: { def: "/qDim" } } }, "qDimensionList", "master_dimension"],
      ] as const) {
        const lo = await app.createSessionObject({ qInfo: { qType: `mcp-search-${kind}` }, ...listDef });
        try {
          const layout = await lo.getLayout();
          for (const it of layout[listKey]?.qItems ?? []) {
            walkStrings(it, "", (path, s) =>
              hit({ kind, itemId: it.qInfo?.qId, title: it.qMeta?.title }, path, s));
          }
        } finally {
          await app.destroySessionObject(lo.id).catch(() => {});
        }
      }

      // 3. variables
      const vl = await app.createSessionObject({
        qInfo: { qType: "mcp-search-vars" },
        qVariableListDef: { qType: "variable", qData: { definition: "/qDefinition" } },
      });
      try {
        const layout = await vl.getLayout();
        for (const v of layout.qVariableList?.qItems ?? []) {
          walkStrings(v, "", (path, s) => hit({ kind: "variable", name: v.qName }, path, s));
        }
      } finally {
        await app.destroySessionObject(vl.id).catch(() => {});
      }

      // 4. load script, with line numbers
      const script: string = await app.getScript();
      script.split("\n").forEach((line, i) => {
        if (matches.length >= cap) { truncated = true; return; }
        const hay = caseSensitive ? line : line.toLowerCase();
        if (hay.includes(needle)) {
          matches.push({ kind: "script", line: i + 1, snippet: line.trim().slice(0, 240) });
        }
      });

      return text({ term, objectsScanned, matchCount: matches.length, truncated, matches });
    },
  );

  server.registerTool(
    "list_master_measures",
    {
      description: "List the app's master measures: id, title, label, expression. Paged.",
      inputSchema: { appId: z.string().describe("App id (GUID)"), ...pageParams },
      annotations: READ,
    },
    async ({ appId, offset, limit }) => {
      const app = await engine.app(appId);
      const lo = await app.createSessionObject({
        qInfo: { qType: "mcp-measurelist" },
        qMeasureListDef: { qType: "measure", qData: { def: "/qMeasure" } },
      });
      try {
        const layout = await lo.getLayout();
        const items = (layout.qMeasureList?.qItems ?? []).map((m: any) => ({
          measureId: m.qInfo.qId,
          title: m.qMeta?.title,
          label: m.qData?.def?.qLabel,
          expression: m.qData?.def?.qDef,
          tags: m.qMeta?.tags,
        }));
        return text(paginate(items, offset, limit));
      } finally {
        await app.destroySessionObject(lo.id).catch(() => {});
      }
    },
  );

  server.registerTool(
    "list_master_dimensions",
    {
      description: "List the app's master dimensions: id, title, field definitions. Paged.",
      inputSchema: { appId: z.string().describe("App id (GUID)"), ...pageParams },
      annotations: READ,
    },
    async ({ appId, offset, limit }) => {
      const app = await engine.app(appId);
      const lo = await app.createSessionObject({
        qInfo: { qType: "mcp-dimensionlist" },
        qDimensionListDef: { qType: "dimension", qData: { def: "/qDim" } },
      });
      try {
        const layout = await lo.getLayout();
        const items = (layout.qDimensionList?.qItems ?? []).map((d: any) => ({
          dimensionId: d.qInfo.qId,
          title: d.qMeta?.title,
          label: d.qData?.def?.qLabelExpression ?? d.qData?.def?.qFieldLabels?.[0],
          fieldDefs: d.qData?.def?.qFieldDefs,
          grouping: d.qData?.def?.qGrouping,
        }));
        return text(paginate(items, offset, limit));
      } finally {
        await app.destroySessionObject(lo.id).catch(() => {});
      }
    },
  );

  server.registerTool(
    "evaluate_master_measure",
    {
      description: "Evaluate a master measure by id or title in the current selection state. Fetches the measure's expression and evaluates it — the KPI -> value step of a trace. (Referencing a master measure as [Name] in a raw expression resolves to a FIELD, not the measure — this tool exists so you never hit that trap.)",
      inputSchema: {
        appId: z.string().describe("App id (GUID)"),
        measureId: z.string().optional().describe("Master measure id"),
        title: z.string().optional().describe("Master measure title (used when measureId is omitted)"),
      },
      annotations: READ,
    },
    async ({ appId, measureId, title }) => {
      if (!measureId && !title) throw new Error("Provide measureId or title");
      const app = await engine.app(appId);
      let id = measureId;
      if (!id) {
        const lo = await app.createSessionObject({
          qInfo: { qType: "mcp-mm-resolve" },
          qMeasureListDef: { qType: "measure", qData: {} },
        });
        try {
          const layout = await lo.getLayout();
          const found = (layout.qMeasureList?.qItems ?? []).find((m: any) => m.qMeta?.title === title);
          if (!found) throw new Error(`Master measure not found by title: ${title}`);
          id = found.qInfo.qId;
        } finally {
          await app.destroySessionObject(lo.id).catch(() => {});
        }
      }
      const measure = await app.getMeasure(id!);
      const prop = await measure.getProperties();
      const expression: string | undefined = prop.qMeasure?.qDef;
      if (!expression) throw new Error(`Measure ${id} has no expression definition`);
      const r = await app.evaluateEx(expression);
      return text({
        measureId: id,
        title: prop.qMetaDef?.title ?? title,
        label: prop.qMeasure?.qLabel,
        expression,
        value: r.qIsNumeric ? r.qNumber : r.qText,
        isNumeric: r.qIsNumeric,
      });
    },
  );

  server.registerTool(
    "get_app_lineage",
    {
      description: "Data lineage of an app's load script as the engine sees it: every LOAD/STORE source and target (files, QVDs, databases, resident, inline, binary). The app -> source step of a trace. NOTE: on a PUBLISHED app the engine denies lineage to user identities (certificate/internal identities bypass this) — copy_app the target and read the copy's lineage.",
      inputSchema: { appId: z.string().describe("App id (GUID)") },
      annotations: READ,
    },
    async ({ appId }) => {
      const app = await engine.app(appId);
      const lineage: Array<{ qDiscriminator?: string; qStatement?: string }> = await app.getLineage();
      const classify = (d: string | undefined, stmt: string | undefined) => {
        const s = (d ?? "").toUpperCase();
        const st = (stmt ?? "").toUpperCase();
        if (st.startsWith("STORE")) return "store";
        if (s.startsWith("INLINE")) return "inline";
        if (s.startsWith("RESIDENT")) return "resident";
        if (s.includes(".QVD")) return "qvd";
        if (s.startsWith("BINARY")) return "binary";
        if (s.includes("PROVIDER=") || s.includes("ODBC") || s.includes("OLEDB") || s.includes("CUSTOM CONNECT")) return "database";
        return "other";
      };
      return text(lineage.map((l) => ({
        kind: classify(l.qDiscriminator, l.qStatement),
        discriminator: l.qDiscriminator,
        statement: l.qStatement,
      })));
    },
  );
}
