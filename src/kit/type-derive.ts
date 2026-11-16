/**
 * Derive the class Type of an object path, as far as Unreal's naming
 * conventions allow.
 *
 * EditorAutomation's first reflection slice can describe a **class** (`class(...)`,
 * `object(...)`) but has no "which class is this object" entry point, so a call
 * tool that is handed an object path cannot ask the editor for its schema
 * directly. Two conventions recover it without an extra editor API:
 *
 * - A class default object is named `Default__<Class>`, so
 *   `/Script/Engine.Default__StaticMeshComponent` is an instance of
 *   `/Script/Engine.StaticMeshComponent`.
 * - A class object's own path IS the class path, and a Blueprint generated
 *   class ends in `_C` (`/Game/Props/BP_Cube.BP_Cube_C`).
 *
 * A level-instance path (`/Game/Maps/Demo.Demo:PersistentLevel.Cube_1`) or a
 * subobject (`...:PersistentLevel.Cube_1.SomeComponent`) names no class, and
 * this returns `undefined` rather than guessing — the history row then shows
 * the values without schema labels, which is honest.
 *
 * @module dsh-unreal/kit/type-derive
 */

/** Prefix that marks a class default object's name. */
const CDO_PREFIX = 'Default__'

/**
 * Derive the canonical `class(...)` Type of an object path, when the path makes
 * it knowable.
 *
 * @param objectPath - a full object path, e.g. `/Script/Engine.Default__Actor`.
 * @returns `class(<class path>)`, or `undefined` when the path names no class.
 */
export function classTypeFromObjectPath(objectPath: string): string | undefined {
  const path = objectPath.trim()
  if (path === '') return undefined
  // A level instance or a subobject path: the class is not in the name.
  if (path.includes(':')) return undefined

  const slash = path.lastIndexOf('/')
  const directory = slash < 0 ? '' : path.slice(0, slash)
  const leaf = slash < 0 ? path : path.slice(slash + 1)
  if (leaf === '') return undefined

  const dot = leaf.lastIndexOf('.')
  const asset = dot < 0 ? '' : leaf.slice(0, dot)
  const objectName = dot < 0 ? leaf : leaf.slice(dot + 1)
  if (objectName === '') return undefined

  if (objectName.startsWith(CDO_PREFIX)) {
    // A class default object is the class object's path with `Default__`
    // inserted into the object name: `/Script/Engine.Default__Actor` is
    // `/Script/Engine.Actor`, and `/Game/Props/BP_Cube.Default__BP_Cube_C` is
    // `/Game/Props/BP_Cube.BP_Cube_C`.
    const classPath = path.replace(`${CDO_PREFIX}`, '')
    if (classPath === path) return undefined
    return `class(${classPath})`
  }

  // A Blueprint generated class object: its path is already the class path.
  if (objectName.endsWith('_C') && asset !== '') return `class(${path})`

  // Engine class objects live directly under /Script and are classes themselves.
  if (directory.startsWith('/Script') && asset !== '') return `class(${path})`

  return undefined
}
