import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Highlight from "@tiptap/extension-highlight";
import TextStyle from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import { sceneCoordsToViewportCoords } from "@excalidraw/excalidraw";
import { Bold, Italic, Underline as UnderlineIcon, Highlighter } from "lucide-react";
import clsx from "clsx";
import { RICH_TEXT_WIDGET_MARKER, EMPTY_RICH_TEXT_DOC } from "./shared";
import { EditAffordance } from "./EditAffordance";

const HIGHLIGHT_COLOR = "#fde68a";

type LayerProps = {
  excalidrawAPIRef: MutableRefObject<any>;
  latestElementsRef: MutableRefObject<readonly any[]>;
  latestAppStateRef: MutableRefObject<any>;
  onCommit: (elementId: string, json: unknown, plainText: string) => void;
};

const isWidget = (el: any) =>
  !!el && !el.isDeleted && el.type === "rectangle" &&
  el.customData && el.customData[RICH_TEXT_WIDGET_MARKER] === true;

const isTiptapDoc = (v: any): boolean =>
  !!v && typeof v === "object" && v.type === "doc" && Array.isArray(v.content);

const plainTextToDoc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : [] }],
});

export const RichTextWidgetLayer: React.FC<LayerProps> = ({
  excalidrawAPIRef, latestElementsRef, latestAppStateRef, onCommit,
}) => {
  const [widgetIds, setWidgetIds] = useState<string[]>([]);
  useEffect(() => {
    let raf = 0;
    let lastSig = "";
    const tick = () => {
      const els = latestElementsRef.current ?? [];
      const ids = els.filter(isWidget).map((e) => e.id);
      const sig = ids.join(",");
      if (sig !== lastSig) { lastSig = sig; setWidgetIds(ids); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [latestElementsRef]);
  return (
    <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 5 }} aria-hidden>
      {widgetIds.map((id) => (
        <RichTextWidgetItem key={id} id={id}
          excalidrawAPIRef={excalidrawAPIRef} latestElementsRef={latestElementsRef}
          latestAppStateRef={latestAppStateRef} onCommit={onCommit}
        />
      ))}
    </div>
  );
};

type ItemProps = {
  id: string;
  excalidrawAPIRef: MutableRefObject<any>;
  latestElementsRef: MutableRefObject<readonly any[]>;
  latestAppStateRef: MutableRefObject<any>;
  onCommit: (elementId: string, json: unknown, plainText: string) => void;
};

const RichTextWidgetItem: React.FC<ItemProps> = ({
  id, excalidrawAPIRef, latestElementsRef, latestAppStateRef, onCommit,
}) => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [editing, setEditing] = useState(false);
  const editingRef = useRef(false);
  const committedRef = useRef(false);
  const dirtyRef = useRef(false);
  const lastContentSigRef = useRef<string>("");

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ history: false, heading: { levels: [1, 2, 3] } }),
      Underline, Highlight.configure({ multicolor: true }), TextStyle, Color,
    ],
    content: EMPTY_RICH_TEXT_DOC,
    editable: false,
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: {
        class: "tiptap-rich-content",
        spellcheck: "false",
        "data-placeholder": "Type to add rich text…",
      },
    },
  });

  // Hydrate editor content from element customData. Called from the rAF
  // geometry loop when the content signature changes (initial load, collab
  // updates, post-commit). Never runs during active editing to avoid
  // clobbering the user's cursor / unsaved changes.
  const hydrateFromElement = useCallback((el: any) => {
    if (!editor || editingRef.current) return;
    const rich = el?.customData?.richText;
    const sig = JSON.stringify(rich ?? null);
    if (sig === lastContentSigRef.current) return;
    lastContentSigRef.current = sig;
    const doc = isTiptapDoc(rich) ? rich : plainTextToDoc(String(el?.text ?? ""));
    try {
      editor.commands.setContent(doc, false);
    } catch {
      editor.commands.setContent(plainTextToDoc(String(el?.text ?? "")), false);
    }
  }, [editor]);

  // Per-frame: sync geometry + trigger content hydration when needed.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const root = rootRef.current;
      const api = excalidrawAPIRef.current;
      const appState = latestAppStateRef.current ?? api?.getAppState?.();
      const el = (latestElementsRef.current ?? []).find((e) => e?.id === id);
      if (root && el && appState) {
        let { x: vx, y: vy } = sceneCoordsToViewportCoords(
          { sceneX: el.x, sceneY: el.y }, appState,
        );
        vx -= appState.offsetLeft ?? 0;
        vy -= appState.offsetTop ?? 0;
        const zoom = appState.zoom?.value ?? 1;
        const w = el.width * zoom;
        const h = el.height * zoom;
        const degree = (180 * (el.angle ?? 0)) / Math.PI;
        const tx = (w * (zoom - 1)) / 2;
        const ty = (h * (zoom - 1)) / 2;
        root.style.left = `${vx}px`;
        root.style.top = `${vy}px`;
        root.style.width = `${w}px`;
        root.style.height = `${h}px`;
        root.style.transform = `translate(${tx}px, ${ty}px) scale(${zoom}) rotate(${degree}deg)`;
        root.style.transformOrigin = "top left";
        root.dataset.selected = String(!!appState.selectedElementIds?.[id]);
        // Re-hydrate content if the element's richText changed externally.
        hydrateFromElement(el);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [excalidrawAPIRef, id, latestAppStateRef, latestElementsRef, hydrateFromElement]);

  const enterEdit = useCallback(() => {
    if (editingRef.current || !editor) return;
    // Do NOT re-hydrate here. The rAF loop already keeps the editor content
    // synced with customData. Calling setContent would reset the cursor and
    // risk overwriting with stale data (the "eraser" bug).
    editor.setEditable(true);
    editingRef.current = true;
    committedRef.current = false;
    dirtyRef.current = false;
    setEditing(true);
    requestAnimationFrame(() => editor.commands.focus());
  }, [editor]);

  const exitAndCommit = useCallback(() => {
    if (!editingRef.current || !editor) return;
    editingRef.current = false;
    editor.setEditable(false);
    setEditing(false);
    // Only commit if the user actually modified content since entering edit
    // mode. Prevents race conditions where exit fires before hydration lands.
    if (!committedRef.current && dirtyRef.current) {
      committedRef.current = true;
      const json = editor.getJSON();
      const text = editor.getText();
      // Invalidate the content sig so the rAF loop doesn't re-hydrate over
      // the just-committed content on the next frame.
      lastContentSigRef.current = JSON.stringify(json);
      onCommit(id, json, text);
    }
  }, [editor, id, onCommit]);

  useEffect(() => {
    if (!editor) return;
    const onUpdate = () => {
      dirtyRef.current = true;
    };
    editor.on("update", onUpdate);
    return () => { editor.off("update", onUpdate); };
  }, [editor]);

  // Exit editing when user clicks outside toolbar AND outside editor DOM.
  // Uses closest() which is more robust than ref.contains() for deeply nested
  // SVG/icon targets inside toolbar buttons.
  useEffect(() => {
    if (!editing || !editor) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target) return;
      if (target.closest("[data-rich-text-toolbar]")) return;
      if (target.closest("[data-rich-text-widget]")) return;
      exitAndCommit();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [editing, editor, exitAndCommit]);

  useEffect(() => {
    if (!editor || !editing) return;
    const dom = editor.view.dom;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        exitAndCommit();
      }
    };
    dom.addEventListener("keydown", onKey);
    return () => dom.removeEventListener("keydown", onKey);
  }, [editor, editing, exitAndCommit]);

  // Commit on unmount (widget deleted while editing).
  useEffect(() => {
    return () => {
      if (editingRef.current && !committedRef.current && dirtyRef.current)
        exitAndCommit();
    };
  }, [exitAndCommit]);

  // Prevent focus shift when clicking toolbar buttons (standard Tiptap pattern:
  // preventDefault on mousedown stops the browser from moving focus to the
  // button, so the editor keeps its text selection and toggle commands work).
  const preventButtonFocus = useCallback((e: React.MouseEvent) => e.preventDefault(), []);

  if (!editor) return null;

  const btn = (active: boolean) =>
    clsx("p-1.5 rounded-lg border-2 transition-all flex items-center justify-center",
      active
        ? "bg-indigo-600 text-white border-indigo-700 dark:border-indigo-400"
        : "bg-white dark:bg-neutral-800 text-slate-700 dark:text-neutral-200 border-slate-200 dark:border-neutral-700 hover:bg-slate-50 dark:hover:bg-neutral-700");

  return (
    <>
      <div ref={rootRef} className="absolute top-0 left-0 overflow-hidden"
        style={{ pointerEvents: editing ? "auto" : "none", background: "transparent" }}
        data-rich-text-widget={id}>
        <EditorContent editor={editor} />
      </div>
      {editing && (
        <div data-rich-text-toolbar
          className="fixed z-[20] left-1/2 -translate-x-1/2 top-[52px] flex flex-wrap items-center gap-1.5 p-2 bg-white/95 dark:bg-neutral-900/95 backdrop-blur border-2 border-black dark:border-neutral-700 rounded-2xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:shadow-[4px_4px_0px_0px_rgba(255,255,255,0.2)]"
          role="toolbar" aria-label="Rich text styling"
          onPointerDown={(e) => e.stopPropagation()}>
          <button type="button" onMouseDown={preventButtonFocus}
            onClick={() => editor.chain().focus().toggleBold().run()}
            className={btn(editor.isActive("bold"))} title="Bold" aria-pressed={editor.isActive("bold")}>
            <Bold size={16} strokeWidth={2.5} />
          </button>
          <button type="button" onMouseDown={preventButtonFocus}
            onClick={() => editor.chain().focus().toggleItalic().run()}
            className={btn(editor.isActive("italic"))} title="Italic" aria-pressed={editor.isActive("italic")}>
            <Italic size={16} strokeWidth={2.5} />
          </button>
          <button type="button" onMouseDown={preventButtonFocus}
            onClick={() => editor.chain().focus().toggleUnderline().run()}
            className={btn(editor.isActive("underline"))} title="Underline" aria-pressed={editor.isActive("underline")}>
            <UnderlineIcon size={16} strokeWidth={2.5} />
          </button>
          <button type="button" onMouseDown={preventButtonFocus}
            onClick={() => editor.chain().focus().toggleHighlight({ color: HIGHLIGHT_COLOR }).run()}
            className={btn(editor.isActive("highlight"))} title="Highlight" aria-pressed={editor.isActive("highlight")}>
            <Highlighter size={16} strokeWidth={2.5} />
          </button>
          <div className="w-px h-5 bg-slate-200 dark:bg-neutral-700 mx-0.5" />
          {[1, 2, 3].map((level) => {
            const active = editor.isActive("heading", { level });
            return (
              <button key={level} type="button" onMouseDown={preventButtonFocus}
                onClick={() => editor.chain().focus().toggleHeading({ level: level as 1 | 2 | 3 }).run()}
                className={clsx(btn(active), "px-1.5 font-extrabold text-[11px]")}
                title={`Heading ${level}`} aria-pressed={active}>
                H{level}
              </button>
            );
          })}
        </div>
      )}
      {!editing && <EditAffordance rootRef={rootRef} onEdit={enterEdit} />}
    </>
  );
};
