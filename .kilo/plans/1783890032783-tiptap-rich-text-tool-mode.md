# Rich Text Editor (Tiptap) — Text Tool Mode

Add an optional Tiptap rich-text editor that layers on top of Excalidraw text elements
(tool 8 / shortcut `8`). Toggled per-user via Settings → "Rich Text Editor - Text Tool Mode".

## Decisions (resolved)

1. **Render target**: Tiptap editor docks in the UI chrome **below the Excalidraw top-left
   tools panel** (high z-index, fixed to editor viewport, stays visible while canvas scrolls).
   Canvas itself keeps Excalidraw native plain-text rendering as fallback when element is not
   being edited. No custom canvas renderer, no foreignObject in export. Lowest risk to
   collab / export / PWA / offline.
2. **Storage**: Tiptap **ProseMirror JSON** stored in `element.customData.richText` on the
   Excalidraw text element. Plain-text mirror synced into `element.text` for canvas + PNG/SVG
   export. No raw HTML persisted (no XSS surface). No DB schema change — `customData` rides
   inside the existing `Drawing.elements` JSON string in SQLite and IndexedDB cache.
3. **Toggle persistence**: localStorage key `excalidash.richTextToolEnabled`, matching the
   existing `autoLockOnOpen` / `imageCompression` editor-toggle pattern (no backend change).
   Default: **off** (opt-in). Server-sync of the toggle is out of scope for this iteration.
4. **Panel visibility**: Shown only when (a) toggle is on AND (b) exactly one Excalidraw
   `text` element is selected (`appState.selectedElementIds` length === 1) AND (c) user can
   edit (`canEdit && !activePreview && !isLocked`). Hidden otherwise.
5. **Editing model**: Tiptap is the source of truth while panel open. On every Tiptap
   `update`, recompute plain text from JSON and call `excalidrawAPI.updateScene` to patch
   that element's `text` + bump version, which flows through the existing
   `handleCanvasChange` → `broadcastChanges` + `debouncedSave` pipeline. This reuses all
   existing persistence/collab/offline logic — no new save path.
6. **customData preservation**: Excalidraw preserves `customData` through `updateScene` /
   serialize / restore by default. Verify via `shared.test.ts`-style snapshot that a text
   element with `customData.richText` survives `getPersistedAppState` round-trip and a
   save→reload cycle.
7. **Line-count guard**: repo enforces `MAX_SOURCE_LINES=399` per file. `EditorView.tsx`
   is already 338 lines — new panel MUST live in its own file to stay under the limit.

## Scope

In scope: toggle, Tiptap editor panel, 5 mark/node controls (H1/H2/H3 headings, bold,
underline, italic, highlight), JSON storage in `customData`, plain-text mirror,
offline/collab compatibility, PWA compatibility, tests.

Out of scope (explicit): server-sync of toggle, list/paragraph/alignment nodes, image/code
blocks, custom canvas rendering, export with styled HTML, migration of existing plain text.

## Files to change

### Frontend deps — `frontend/package.json`
Add:
- `@tiptap/react`
- `@tiptap/pm` (ProseMirror peer)
- `@tiptap/starter-kit` (bold, italic, headings, paragraph, history)
- `@tiptap/extension-underline`
- `@tiptap/extension-highlight`
- `@tiptap/extension-text-style`
- `@tiptap/extension-color` (for highlight color; optional v1)

Run `cd frontend && npm install`. Confirm lockfile + `overrides` block still consistent.

### Settings toggle — `frontend/src/pages/Settings.tsx`
- Add `richTextToolEnabled` state + `toggleRichTextTool`, persisted to localStorage key
  `excalidash.richTextToolEnabled` (mirror the `autoLockOnOpen` pattern: read on mount,
  write on toggle). Default `false`.
- Pass `richTextToolEnabled` + `toggleRichTextTool` down through `SettingsMainGrid`.
- `SettingsMainGrid.tsx`: add a new toggle card labeled
  **"Rich Text Editor - Text Tool Mode"** with help text:
  "Enable a Tiptap rich-text panel for Excalidraw text elements (tool 8). Off = default
  Excalidraw text behavior."

### Editor wiring — `frontend/src/pages/Editor.tsx`
- Read toggle from localStorage (small helper, e.g. reuse `useEditorAutoHide` style hook
  pattern). Keep value in state so toggling in Settings (if Editor remounts) picks it up.
- Track currently-selected single text element id via a lightweight effect subscribing to
  `excalidrawAPI.current` change events OR reading `appState.selectedElementIds` inside the
  existing `handleCanvasChange` callback (preferred — no new subscription). Store
  `selectedTextElementId` + the element ref.
- Pass `richTextToolEnabled`, `selectedTextElement`, `excalidrawAPI` to `EditorView`.

### Editor UI — `frontend/src/pages/editor/EditorView.tsx`
- Add props: `richTextToolEnabled: boolean`, `selectedTextElement: any | null`,
  `onRichTextChange: (elementId: string, json: any, plainText: string) => void`.
- Render `<RichTextToolPanel .../>` absolutely positioned in the editor viewport:
  - Below the Excalidraw top-left tools panel (`top: ~110px`, `left: ~12px`, high z-index
    e.g. `z-[20]`, `position: absolute` inside `editorContainerRef` so it overlays canvas
    and stays put during canvas pan/scroll because it is anchored to the viewport, not the
    canvas world coords).
  - Width ~ `min(420px, calc(100vw - 24px))`, max-height clamp with internal scroll.
- Conditionally mount only when panel-visibility rules (decision 4) are met.

### New component — `frontend/src/pages/editor/RichTextToolPanel.tsx` (< 399 lines)
Owns:
- Tiptap `useEditor` + `<EditorContent>`.
- Extensions: `StarterKit` (with `heading` levels `{1,2,3}`), `Underline`, `Highlight`
  (multicolor default), `TextStyle`, `Color`.
- Toolbar buttons (use existing `lucide-react` icons — `Bold`, `Italic`, `Underline`,
  `Highlighter`, and heading dropdown `H1/H2/H3`):
  - Bold, Italic, Underline, Highlight, Heading level toggle.
- Bindings:
  - On mount / when `selectedTextElement` changes: hydrate editor content from
    `element.customData?.richText` JSON if present; else from `element.text` (wrap in a
    single paragraph). Guard against re-hydrating on every render — key by element id.
  - On `editor.on('update')`: serialize `editor.getJSON()`, compute plain text via
    `editor.getText()`, call `onRichTextChange(elementId, json, plainText)`. Debounce
    plain-text mirror writes (e.g. 120ms) to avoid updateScene churn per keystroke.
- A11y: toolbar buttons `aria-pressed` from `editor.isActive(...)`.

### Scene sync helper — `frontend/src/pages/editor/shared.ts`
Add exported pure helper:
```ts
export const buildRichTextElementPatch = (
  element: any,
  json: unknown,
  plainText: string,
) => ({
  id: element.id,
  text: plainText,
  customData: { ...(element.customData ?? {}), richText: json },
});
```
Pure, unit-testable. `Editor.tsx` consumes it in the `onRichTextChange` handler:
```ts
const patch = buildRichTextElementPatch(el, json, plainText);
excalidrawAPI.current.updateScene({
  elements: latestElementsRef.current.map(e => e.id === patch.id ? { ...e, ...patch } : e),
});
```
`updateScene` triggers `onChange` → existing `handleCanvasChange` handles broadcast + save.

## Data flow (end to end)

Load: scene loader (existing) reads `Drawing.elements` JSON → Excalidraw → user selects
text element → `RichTextToolPanel` hydrates from `element.customData.richText`.

Edit: Tiptap `update` → `onRichTextChange` → `updateScene` patches `text` + `customData`
→ Excalidraw `onChange` fires → `handleCanvasChange` → `broadcastChanges` (socket) +
`debouncedSave` (HTTP) + IndexedDB cache via existing path. No new save channel.

Collab: peer receives `element-update` with patched element (customData included) →
existing `useEditorCollaboration` reconciliation applies it. If peer has toggle off, they
still see plain `element.text` on canvas (graceful). If peer has toggle on and selects that
element, panel hydrates from the synced `customData.richText`.

Offline: existing `useEditorOfflineFlush` + `pendingOps` carry the element JSON unchanged.
PWA: rich text is inside element JSON; no asset/service-worker change. Tiptap JS bundles
into the existing Vite build and is precached by `vite-plugin-pwa` automatically.

Export (PNG/SVG/backup): PNG/SVG use Excalidraw canvas = plain text (acceptable fallback).
`.excalidraw` / `.excalidash` backup JSON includes `customData` → round-trips. Verify.

## Compatibility & failure modes

- **Toggle off**: zero new behavior, zero new code paths execute. Tiptap bundle still ships
  but `RichTextToolPanel` never mounts (tree-shake impact only).
- **Element without customData.richText**: panel hydrates from `element.text`; first edit
  creates `customData.richText`. Non-destructive.
- **customData stripped by external editor (raw .excalidraw import)**: panel falls back to
  plain text; no crash.
- **Tiptap JSON invalid/old shape**: wrap `editor.commands.setContent(json)` in try/catch;
  on failure fall back to `element.text`.
- **Multi-element selection**: panel hidden (rule: exactly one text element).
- **Non-text element selected**: panel hidden.
- **View-only / preview / locked**: panel hidden.
- **Collab peer editing same element**: standard Excalidraw last-write-wins via
  `updateScene`; rich JSON replaces wholesale (acceptable for v1; CRDT out of scope).
- **Migration**: none. Existing drawings load unchanged; toggle defaults off.

## Validation / tests

1. **Unit** (`shared.test.ts`):
   - `buildRichTextElementPatch` returns expected shape; preserves existing `customData`
     keys; sets `text` and `customData.richText`.
   - `getPersistedAppState` round-trip keeps a text element's `customData.richText`
     intact (extend existing snapshot test).
2. **Component** (new `RichTextToolPanel.test.tsx`):
   - Renders toolbar; hydrates from `customData.richText`; hydrates from `element.text`
     when no richText; calls `onRichTextChange` with JSON + plain text on input; does not
     re-hydrate when same element re-renders.
3. **Integration** (existing editor test pattern, e.g. `useEditorChrome.test.tsx` style):
   - Toggling localStorage flag + selecting a single text element mounts panel; selecting
     two elements unmounts it; view-only mode unmounts it.
4. **E2E** (`e2e/`): add spec — open drawing, enable toggle in Settings, select text
   element, apply Bold + Highlight, reload, verify styles persist; verify offline
   (DevTools offline) edit still saves and replays on reconnect. Run via `npm test` in
   `e2e/` (`NO_SERVER=true` against running `make dev`).
5. **Lint / typecheck / build**: `cd frontend && npm run lint && npx tsc -b && npm run build`.
   Run `npm run check:max-lines` to confirm no file exceeds 399 lines.
6. **Manual**: verify collab — two browser sessions, one with toggle on edits rich text,
   peer with toggle off sees plain text update live; peer with toggle on sees styled.

## Implementation order

1. Add Tiptap deps; confirm install + build.
2. Add toggle in Settings (localStorage) + SettingsMainGrid card.
3. Add `buildRichTextElementPatch` in `shared.ts` + unit test.
4. Build `RichTextToolPanel.tsx` + component test.
5. Wire selection tracking + panel mount conditions in `Editor.tsx` / `EditorView.tsx`.
6. Wire `onRichTextChange` → `updateScene` path.
7. Extend `shared.test.ts` for customData round-trip.
8. Add E2E spec.
9. Full lint + typecheck + build + max-lines + `make test-all`.

## Open notes for implementer

- Confirm `@excalidraw/excalidraw@^0.18.1` exposes `customData` on text elements and
  preserves it through `updateScene` (it does per Excalidraw 0.15+); add a guard test.
- Tiptap `StarterKit` includes `History` — may conflict with Excalidraw undo; consider
  `StarterKit.configure({ history: false })` and rely on Excalidraw's own undo stack
  (since we patch via `updateScene`). Decide during implementation; prefer disabling
  Tiptap history to keep one undo stack.
- Debounce plain-text mirror writes to avoid `updateScene` per keystroke flooding the
  collab socket (see `debouncedSave` pattern already in repo).
- Keep `RichTextToolPanel.tsx` under 399 lines; split toolbar into a sub-component if needed.
