/**
 * Short, human display labels for EditorAutomation's canonical Type strings.
 *
 * `struct(/Script/CoreUObject.Vector)` is precise but unreadable in a table —
 * and its length is what used to make the Type column wrap mid-identifier.
 * The panel shows `struct Vector` and keeps the canonical string in the cell's
 * `title` (and in the raw JSON), so nothing is lost.
 *
 * @module dsh-unreal/client/type-label
 */

/** The kind word a canonical Type starts with, e.g. `struct` in `struct(...)`. */
interface ParsedType {
  readonly kind: string
  readonly inner: string
}

/**
 * Split `kind(inner)` into its parts.
 *
 * @param type - canonical Type string.
 * @returns the parts, or `undefined` for a scalar/unknown form.
 */
function parse(type: string): ParsedType | undefined {
  const trimmed = type.trim()
  const open = trimmed.indexOf('(')
  if (open <= 0 || !trimmed.endsWith(')')) return undefined
  return { kind: trimmed.slice(0, open), inner: trimmed.slice(open + 1, -1) }
}

/**
 * The identifying tail of a path: `…/CoreUObject.Vector` → `Vector`.
 *
 * @param path - a class/struct/enum/object path.
 * @returns the tail name, or the path when it has no separator.
 */
export function pathTail(path: string): string {
  const cut = Math.max(path.lastIndexOf('.'), path.lastIndexOf('/'))
  const tail = path.slice(cut + 1)
  return tail === '' ? path : tail
}

/**
 * Split a Type's inner content on its top-level commas (for `map(K, V)`).
 *
 * @param inner - the inside of a `kind(...)` Type.
 * @returns the top-level parts.
 */
function splitTopLevel(inner: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index]
    if (character === '(') depth += 1
    else if (character === ')') depth -= 1
    else if (character === ',' && depth === 0) {
      parts.push(inner.slice(start, index))
      start = index + 1
    }
  }
  parts.push(inner.slice(start))
  return parts.map(part => part.trim()).filter(part => part !== '')
}

/**
 * UE-facing display names for EditorAutomation's compact scalar Type words.
 * Canonical wire grammar stays `string`/`name`/`text`.
 */
const SCALAR_LABELS: Readonly<Record<string, string>> = {
  string: 'FString',
  name: 'FName',
  text: 'FText',
}

/**
 * The bare element name of a Type, without its wrapper kind:
 * `struct(/Script/CoreUObject.Vector)` → `FVector`, `double` → `double`.
 *
 * @param type - a Type string.
 * @returns the element name.
 */
function bareLabel(type: string): string {
  const parsed = parse(type)
  if (parsed === undefined) return SCALAR_LABELS[type.trim()] ?? type
  const tail = pathTail(parsed.inner)
  return parsed.kind === 'struct' && !tail.startsWith('F') ? `F${tail}` : tail
}

/**
 * A short display label for one canonical Type.
 *
 * - `struct(/Script/CoreUObject.Vector)` → `struct Vector`
 * - `class(/Script/Engine.StaticMeshComponent)` → `class StaticMeshComponent`
 * - `enum(/Script/Engine.ECollisionEnabled)` → `enum ECollisionEnabled`
 * - `object(/Script/Engine.Object)` → `object Object`
 * - `array(struct(…Vector))` → `array Vector`, `map(…)` → `map Vector, double`
 * - `double` → `double` (scalars keep their name)
 *
 * @param type - canonical Type string, possibly absent.
 * @returns the short label, or `undefined` when there is no Type.
 */
export function typeLabel(type: string | undefined): string | undefined {
  if (type === undefined) return undefined
  const trimmed = type.trim()
  if (trimmed === '') return undefined
  const parsed = parse(trimmed)
  if (parsed === undefined) return SCALAR_LABELS[trimmed] ?? trimmed

  const { kind, inner } = parsed
  switch (kind) {
    case 'array':
      return `TArray<${bareLabel(inner)}>`
    case 'set':
      return `TSet<${bareLabel(inner)}>`
    case 'map': {
      const parts = splitTopLevel(inner)
      const key = parts[0]
      const value = parts[1]
      if (key === undefined || value === undefined) return 'TMap'
      return `TMap<${bareLabel(key)}, ${bareLabel(value)}>`
    }
    case 'struct': {
      const tail = pathTail(inner)
      return tail.startsWith('F') ? tail : `F${tail}`
    }
    case 'class':
    case 'enum':
    case 'object':
      return `${kind} ${pathTail(inner)}`
    default:
      return `${kind} ${pathTail(inner)}`
  }
}
