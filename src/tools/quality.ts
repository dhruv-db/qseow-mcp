// Engine-side quality checks shared by the analytics tools (trust envelope)
// and the builder/validation gate. Everything here is read-only.
import { badFieldSubstrings } from "./shared.js";

/** Validate an expression with the engine BEFORE trusting its result.
 *  Catches the silent killers: a misspelled field does not error at evaluate
 *  time — it just makes the number wrong. */
export async function expressionWarnings(app: any, expression: string): Promise<string[]> {
  const warnings: string[] = [];
  try {
    const chk = await app.checkExpression(expression);
    if (chk.qErrorMsg) warnings.push(`expression error: ${chk.qErrorMsg}`);
    const bad = badFieldSubstrings(expression, chk.qBadFieldNames ?? []);
    if (bad.length) warnings.push(`unknown field(s): ${bad.join(", ")} — the engine returns null/0 for these rather than erroring`);
  } catch { /* CheckExpression unavailable — do not block evaluation */ }
  return warnings;
}

/** Current selection state, compactly. Stamped onto every analytics return so
 *  a number can never silently masquerade as the unfiltered truth. */
export async function activeSelections(app: any): Promise<Array<{ field: string; selectedCount: number; selected?: string }>> {
  const obj = await app.createSessionObject({
    qInfo: { qType: "mcp-selection-context" },
    qSelectionObjectDef: {},
  });
  try {
    const layout = await obj.getLayout();
    return (layout.qSelectionObject?.qSelections ?? []).map((s: any) => ({
      field: s.qField, selectedCount: s.qSelectedCount, selected: s.qSelected,
    }));
  } finally {
    await app.destroySessionObject(obj.id).catch(() => {});
  }
}

/** Field names present in the app's data model (for dimension validation). */
export async function fieldNames(app: any): Promise<Set<string>> {
  const obj = await app.createSessionObject({
    qInfo: { qType: "mcp-fieldlist" },
    qFieldListDef: { qShowSystem: false, qShowHidden: false, qShowSemantic: true },
  });
  try {
    const layout = await obj.getLayout();
    return new Set((layout.qFieldList?.qItems ?? []).map((f: any) => f.qName));
  } finally {
    await app.destroySessionObject(obj.id).catch(() => {});
  }
}
