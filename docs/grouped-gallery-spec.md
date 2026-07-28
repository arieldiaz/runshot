# Grouped gallery: groups first, metadata second

Status: approved product shape; ready for implementation

## Decision

Runshot will let each captured screen declare a human-readable `group` and
optional `role`, `stage`, and `flow` metadata.

The Screens view will render groups as separate titled sections. `role` and
`stage` will be filters across those sections. `flow` will continue to control
coordinates and connectors inside a group.

`group` is the structural primitive. Runshot will not make flows top-level:
some groups are journeys, some are state families, and some are inventories
with no meaningful sequence.

## Goals

- Let each app define its own editorial review structure without Runshot
  hard-coding product-specific roles or lifecycle names.
- Preserve the existing directional canvas for groups that contain a flow.
- Support non-linear screen families and unsequenced inventories.
- Keep existing configs and manifests rendering unchanged.
- Make the minimum useful addition one field: `group`.

## Non-goals

- Defining a universal taxonomy for roles, stages, or groups.
- Inferring product structure from routes, filenames, step order, or notes.
- Replacing `variant`; variants remain separate capture passes.
- Building nested groups or a general-purpose faceted-content system.
- Forcing connectors between every pair of screens.

## Config contract

The four fields live on screenshot-producing `walkthrough.steps[]` entries,
alongside `route`, `state`, `variant`, and the other existing screen metadata.

```json
{
  "action": "screenshot",
  "route": "/home",
  "state": "ready",
  "group": "Home",
  "role": "shared",
  "stage": "steady state",
  "flow": { "col": 1, "row": 0 }
}
```

### `group`

- Optional non-empty string.
- Human-readable and app-defined; examples: `Public`, `Access`, `Home`,
  `Hero`, `Onboarding`, `Voice`, `Guest result`.
- Establishes gallery sections in first-appearance order.
- Screens without a group belong to one implicit legacy group whose title is
  not shown when it is the only group in a run.

### `role`

- Optional non-empty string.
- Describes who is experiencing the screen; examples: `guest`, `curator`,
  `Hero`, `shared`.
- Used as a gallery filter, not as a section or permission model.
- Values are compared exactly after trimming; display casing is preserved.

### `stage`

- Optional non-empty string.
- Describes the relationship or lifecycle moment; examples: `first run`,
  `steady state`, `transition`, `recovery`.
- Used as a gallery filter, not as a sequence.
- Values are compared exactly after trimming; display casing is preserved.

### `flow`

- Retains the existing `{ "col": number, "row": number }` shape.
- Coordinates are local to the screen's `group` and `variant`.
- A screen without coordinates is still visible and receives the existing
  collision-free fallback placement within its group.
- Connectors are drawn only within a group and only when sequence is
  meaningful under the connector rule below.

## Manifest contract

`walkthrough.mjs` copies `group`, `role`, and `stage` into each screen entry in
`manifest.json`, just as it already does for `flow` and `variant`.

```json
{
  "idx": 8,
  "label": "08-home-ready",
  "route": "/home",
  "state": "ready",
  "note": "",
  "group": "Home",
  "role": "shared",
  "stage": "steady state",
  "flow": { "col": 1, "row": 0 },
  "variant": null
}
```

No manifest version bump is required: all new keys are optional and old
readers already ignore unknown keys.

## Gallery behavior

### Section layout

Within the active variant, the Screens view:

1. partitions screens by `group` in first-appearance order;
2. renders each group as its own titled canvas section;
3. normalizes coordinates independently per group; and
4. stacks group sections vertically with no cross-group arrows.

If every visible screen is ungrouped, the gallery renders the current single
canvas with no synthetic heading. This is the exact legacy path.

If grouped and ungrouped screens coexist, the ungrouped screens render last
under `Other`. Apps should add explicit groups rather than rely on `Other`.

### Filters

Role and stage controls appear only when at least one screen in the run declares
the corresponding field.

- Each control defaults to `All`.
- A selected role and stage combine with AND semantics.
- A screen missing a filtered field is hidden when that field has a specific
  selection.
- Empty groups disappear after filtering.
- Filters apply inside the active variant; switching variants preserves a
  selection when that value exists, otherwise resets that control to `All`.
- Filter state is encoded in the URL so a review view can be linked and browser
  Back/Forward remains useful.

Device switching does not change grouping or filter state.

### Connector rule

The existing consecutive-screen connector behavior is scoped to each
`group` + `variant` pair. Sequence is the original manifest order after
filtering to that pair.

No connector crosses a group boundary. A group with no explicit `flow`
coordinates renders as an inventory grid without arrows; Runshot does not
invent a journey. If at least two screens in the group declare `flow`,
connectors are drawn between consecutive flow-positioned screens, while
unpositioned screens remain visible but unconnected.

This deliberately changes the legacy fallback only for explicitly grouped
screens. The ungrouped legacy canvas keeps its current placement and connector
behavior.

### Screen metadata

The expanded caption includes `group`, `role`, and `stage` when present, in
addition to the existing state, variant, note, and flow details.

## Relationship to variants

`variant` and `group` solve different problems:

- `variant` selects a capture pass, such as zero state versus dummy data.
- `group` structures the screens within that capture pass for review.

The control order is: device, variant, role, stage. The content hierarchy is:
run, active variant, group section, screen.

## Backward compatibility

- Existing step configs need no edits.
- Existing manifests need no migration.
- A run with no `group`, `role`, or `stage` renders exactly as it does today.
- Existing `variant` toggles and per-device layouts keep working.
- Existing `flow` coordinates remain valid. They become group-local only when
  the app opts into explicit groups.

## Implementation plan

1. Extend `runStep()` in `scripts/walkthrough.mjs` to copy normalized `group`,
   `role`, and `stage` strings into manifest screen entries.
2. Update the template and README config reference with the new optional fields
   and one grouped example.
3. Refactor `renderRun()` in `scripts/gallery.mjs` to build layouts by
   `(device, variant, group)` rather than `(device, variant)`.
4. Render one canvas section per visible group and add role/stage controls.
5. Update client-side layout/filter code and URL state handling.
6. Add smoke fixtures for legacy, grouped, mixed, filtered, and multi-variant
   runs.
7. Render representative desktop and mobile evidence and complete the required
   ChiefDesigner review before merging the user-visible gallery change.

## Acceptance criteria

- A config can attach `group`, `role`, and `stage` to any screenshot-producing
  step, and the manifest preserves them.
- Two groups with overlapping `flow` coordinates render in separate sections
  without overlap or cross-group arrows.
- A grouped screen inventory without coordinates renders every screen and draws
  no arrows.
- Role and stage filters work independently and together, hide empty sections,
  and survive device changes.
- Variant switching never mixes screens or coordinates across variants.
- A legacy fixture produces the same section count, labels, coordinates, and
  connectors as before this change.
- Mixed grouped/ungrouped runs place ungrouped screens under `Other`.
- Empty and failed runs still render without a client-side exception.
- Desktop and mobile gallery renders receive ChiefDesigner sign-off.

## Strongest case against

Three metadata dimensions can make app configs verbose and inconsistent. The
guardrail is structural: only `group` changes the primary review layout, while
`role`, `stage`, and `flow` remain optional. Runshot preserves the app's words
instead of growing a central taxonomy that would inevitably fit some products
poorly.
