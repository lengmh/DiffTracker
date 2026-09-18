# Native Review PoC

Branch: `spike/native-review-poc`

This spike tests whether Code Diff Tracker can keep its current baseline/review backend while replacing most custom diff rendering with VS Code-native review surfaces.

## Implemented stable-API path

- A dedicated SCM provider: `diffTrackerReview`
- `QuickDiffProvider` backed by the existing `diff-tracker-original:` virtual baseline
- Native side-by-side diff via `vscode.diff`
- Native multi-file review via `vscode.changes`, with a single-diff/webview fallback for older hosts
- Quick Diff hunk actions through the stable `scm/change/title` menu
- Modified-side selection capture through the stable `editor/context` menu and `window.activeTextEditor.selections`
- An explicit post-Keep baseline refresh hook for native diff models, while the tracker remains the authoritative baseline
- Existing `DiffTracker.keepBlock()` / `revertBlock()` are reused; no second patch engine is introduced

No proposed API is enabled.

## Important API boundary

VS Code currently exposes the Git-like diff gutter toolbars `diffEditor/gutter/hunk` and
`diffEditor/gutter/selection` as proposed contribution points. A Marketplace release therefore
must not depend on those menus.

The stable PoC instead uses:

1. Quick Diff inline hunk toolbar: `scm/change/title`
2. Normal Diff/Multi Diff modified-side selection: `editor/context`

## What the selection probe proves

`Native Review PoC: Probe Selected Lines` records the exact one-based selected line ranges and
maps them to Code Diff Tracker blocks.

- If one complete tracker block is selected, the PoC can Keep/Revert it through the existing backend.
- If only part of a tracker block is selected, the PoC intentionally refuses to mutate state and reports:
  `Native selection is available, but line-granular Keep/Revert requires a backend line-action API.`

That distinction is deliberate: a partial-block failure in this spike is a backend-granularity gap,
not a VS Code frontend-access gap.

## Manual validation

1. Run the extension from this branch and allow the baseline to become ready.
2. Modify an existing text file in two separated places.
3. In Source Control, open **Code Diff Tracker Review (PoC)** and open the changed file.
4. In the normal editor, click a Quick Diff gutter marker:
   - verify **Keep** and **Revert** appear in the inline Quick Diff title
   - invoke each and verify only that tracker block is resolved
5. Run **Native Review PoC: Open All Changes**:
   - current VS Code should open the native multi-diff editor
   - older hosts may fall back to one native diff
6. In the modified side of a native diff, select all lines belonging to one tracker block and use the editor context menu:
   - **Keep Selected Block**
   - **Revert Selected Block**
7. Create a multi-line tracker block, select only one line, and run **Probe Selected Lines**:
   - the output channel must show the exact selected line
   - `partialBlockIds` must contain the intersected block
   - Keep/Revert must refuse the partial mutation rather than silently widening it

## Architecture result this PoC is designed to decide

If the runtime tests pass on current VS Code:

- keep Code Diff Tracker's baseline/session/stale/recovery/backend semantics
- use VS Code-native diff rendering, Quick Diff and multi-diff wherever possible
- retain custom UI only for capabilities the stable API cannot surface
- add a backend line-action API later only if true partial-block Keep/Revert is still required

The PoC should not be merged into a release branch as-is; it is an architectural spike.
