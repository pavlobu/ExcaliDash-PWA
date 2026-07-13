import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import { Pencil } from "lucide-react";

/**
 * Small "Edit" button pinned to the top-right of the widget's viewport rect,
 * shown only when the host rectangle is selected. It is the only pointer-event
 * surface on a non-editing widget (the rest of the overlay is pointer-events:
 * none so Excalidraw receives canvas clicks to drag/resize/rotate the host).
 */
export const EditAffordance: React.FC<{
  rootRef: MutableRefObject<HTMLDivElement | null>;
  onEdit: () => void;
}> = ({ rootRef, onEdit }) => {
  const btnRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const root = rootRef.current;
      const btn = btnRef.current;
      if (root && btn) {
        const selected = root.dataset.selected === "true";
        if (selected) {
          const rect = root.getBoundingClientRect();
          btn.style.display = "flex";
          btn.style.left = `${rect.right - 52}px`;
          btn.style.top = `${rect.top + 4}px`;
        } else {
          btn.style.display = "none";
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [rootRef]);
  return (
    <button
      ref={btnRef}
      type="button"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onEdit();
      }}
      className="fixed z-[16] items-center gap-1 px-1.5 py-1 bg-white/95 dark:bg-neutral-900/95 backdrop-blur border-2 border-black dark:border-neutral-700 rounded-lg shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)] text-slate-900 dark:text-neutral-100 text-[10px] font-bold"
      style={{ display: "none", pointerEvents: "auto" }}
      title="Edit rich text"
      aria-label="Edit rich text"
    >
      <Pencil size={12} strokeWidth={2.5} />
      Edit
    </button>
  );
};
