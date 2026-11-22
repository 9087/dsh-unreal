/**
 * Durable record schema: one recorded EditorAutomation call.
 *
 * Record schemas are **zod**, not Schemastery: `dsh-storage-domain` splits the
 * two on purpose — plugin `Config` is Schemastery, domain records are zod.
 *
 * The row keeps **facts, not prose**: the tool name, the Engine's own error
 * text, the raw params and the canonical result. The panel composes its labels
 * at render time from those facts, so the same record reads correctly in every
 * language and after a schema-visible change to the panel.
 *
 * @module dsh-unreal/records
 */

import { z } from 'zod'

/**
 * One named member type, for the Details tree's field labels.
 *
 * Stored with the record rather than looked up at render time: the panel must
 * show a row the same way after a restart, when the editor may be gone.
 */
export const detailMemberTypeSchema = z.object({
  /** Member name (C++ name for a struct member, `[n]` for an array item). */
  name: z.string(),
  /** Canonical Type string, when known. */
  type: z.string().optional(),
})

/** One row of a Details section. */
export const detailFieldSchema = z.object({
  /** Field name: a parameter name, a property path, `ReturnValue`, … */
  name: z.string(),
  /** Canonical Type string, when the schema was resolvable. */
  type: z.string().optional(),
  /** `input`, `output`, `input-output` or `return`. */
  direction: z.string().optional(),
  /** The value in the Engine's decoded JSON form (scalars as strings). */
  value: z.json().optional(),
  /** A display label for an enum's numeric value, when the enum was cached. */
  enumLabel: z.string().optional(),
  /** Full FText identity for the enum display name. */
  enumLabelRef: z.json().optional(),
  /** The enum entry's code name. */
  enumName: z.string().optional(),
  /** Raw JSON text when the value did not parse. */
  raw: z.string().optional(),
  /** Immediate member types, so the tree can label nested fields. */
  members: z.array(detailMemberTypeSchema).optional(),
  /** True when the parameter was omitted and the Engine default applies. */
  omitted: z.boolean().optional(),
  /** A short human note about the field. */
  note: z.string().optional(),
})

/** One section of a Details view. */
export const detailSectionSchema = z.object({
  /** What the section shows; the panel titles it from this. */
  kind: z.enum(['inputs', 'outputs', 'returns', 'change', 'value', 'type', 'screenshot', 'calls']),
  /** Rows, for the table-shaped kinds. */
  fields: z.array(detailFieldSchema).optional(),
  /** The pre-write field, for `change`. */
  before: detailFieldSchema.optional(),
  /** The post-write field, for `change`. */
  after: detailFieldSchema.optional(),
  /** A note shown with the section. */
  note: z.string().optional(),
})

/**
 * Typed enrichment persisted on one record.
 *
 * Optional on the record, because rows written before this schema existed must
 * keep loading: the panel falls back to its raw-JSON disclosure for them.
 */
export const callDetailsSchema = z.object({
  /** Schema version. */
  v: z.literal(1),
  /** Sections in display order. */
  sections: z.array(detailSectionSchema),
  /** True when a budget forced part of the details out. */
  truncated: z.boolean().optional(),
})

/** One recorded EditorAutomation call. */
export const operationRecordSchema = z.object({
  /** Stable record id, unique across sessions. */
  id: z.string(),
  /** Epoch milliseconds the call completed. */
  time: z.number(),
  /** DSH session the call belonged to, when the caller was agent-scoped. */
  sessionId: z.string().optional(),
  /** Tool-call id, the correlation key back to the session log. */
  callId: z.string().optional(),
  /** Wire tool name, e.g. `unreal_get_class_info`. */
  tool: z.string(),
  /** Whether the call succeeded. */
  ok: z.boolean(),
  /**
   * Schema generation of the record. New records stamp `2`; a record without
   * this field predates typed Details, which is how the panel knows to call it
   * legacy even when its tool is a reflection one that never carries Details.
   */
  recordVersion: z.number().optional(),
  /** Classified failure code, when `ok` is false. */
  errorCode: z.string().optional(),
  /** The Engine's own failure text (or the transport's), kept verbatim. */
  errorMessage: z.string().optional(),
  /** The Engine's remediation hint, when it supplied one. */
  errorHint: z.string().optional(),
  /** Wall-clock duration measured by the tool wrapper. */
  durationMs: z.number().optional(),

  // ---- target identity: what the row names on its second line -------------
  /** Reflection Type string: `class(...)`, `struct(...)` or `enum(...)`. */
  targetType: z.string().optional(),
  /** Object the call targeted (property and function tools). */
  objectPath: z.string().optional(),
  /** Property path the call read or wrote. */
  propertyPath: z.string().optional(),
  /** Function the call invoked. */
  functionName: z.string().optional(),
  /** Canonical Type string of a property, when the call resolved one. */
  propertyType: z.string().optional(),

  // ---- payloads -----------------------------------------------------------
  /** The tool arguments exactly as the registry parsed them (bounded). */
  params: z.json().optional(),
  /** The canonical result value the tool returned (bounded). */
  result: z.json().optional(),
  /** One-line outcome preview, for the collapsed row. */
  resultSummary: z.string().optional(),
  /**
   * Typed enrichment for the panel's Details view. Absent on records written
   * before this field existed, and on calls with nothing to enrich.
   */
  details: callDetailsSchema.optional(),
  /**
   * The primary Remote Control call this operation wrapped: the request, out
   * parameters and return value the card's Raw data view shows. Absent for tools
   * whose work is not one reflected call (batch, call_function, local tools) and
   * for records written before this field existed.
   */
  rc: z.object({
    objectPath: z.string(),
    functionName: z.string(),
    parametersJson: z.string(),
    outParametersJson: z.string(),
    returnValueJson: z.string().optional(),
    returnType: z.string().optional(),
  }).optional(),
  /**
   * Every Remote Control call the tool actually made, in order: request, out
   * parameters and return value as the Engine saw them. This is the card's raw
   * data when present; `rc` stays only for records written before this array
   * existed.
   */
  rcCalls: z.array(z.object({
    objectPath: z.string(),
    functionName: z.string(),
    parametersJson: z.string(),
    outParametersJson: z.string(),
    returnValueJson: z.string().optional(),
    returnType: z.string().optional(),
    errorMessage: z.string().optional(),
  })).optional(),
  /** Whether the call's reflection answer was served from the schema cache. */
  cached: z.boolean().optional(),
})

/** One recorded EditorAutomation call. */
export type OperationRecord = z.infer<typeof operationRecordSchema>

/** One durable display-name translation: key + culture → resolved text. */
export const translationRecordSchema = z.object({
  /** Unreal culture, e.g. "zh-Hans". */
  culture: z.string(),
  /** UObjectDisplayNames key. */
  key: z.string(),
  /** Resolved display text; empty entries are not stored. */
  text: z.string(),
  /** Host time this text was last refreshed. */
  updatedAt: z.number(),
})

/** One durable display-name translation. */
export type TranslationRecord = z.infer<typeof translationRecordSchema>

/** One session's share of the history, without the records themselves. */
export interface SessionGroup {
  /** The session id; absent records are grouped under the empty id. */
  readonly sessionId: string
  /** Records recorded for that session. */
  readonly count: number
  /** Epoch milliseconds of the newest record in the group. */
  readonly lastTime: number
}
