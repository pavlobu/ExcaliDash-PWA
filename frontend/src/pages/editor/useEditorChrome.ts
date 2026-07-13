import { useEffect, useState } from 'react';
import throttle from 'lodash/throttle';
import { isStandalone } from '../../pwa';

type UseEditorChromeOptions = {
  drawingName: string;
  autoHideEnabled: boolean;
  isRenaming: boolean;
};

export const useEditorChrome = ({
  drawingName,
  autoHideEnabled,
  isRenaming,
}: UseEditorChromeOptions) => {
  const [isHeaderVisible, setIsHeaderVisible] = useState(true);

  useEffect(() => {
    document.title = `${drawingName} - ExcaliDash`;
    return () => {
      document.title = 'ExcaliDash';
    };
  }, [drawingName]);

  useEffect(() => {
    if (!autoHideEnabled || isRenaming) {
      setIsHeaderVisible(true);
      return;
    }

    let hideTimeout: ReturnType<typeof setTimeout> | null = null;
    let isInTriggerZone = false;

    const handleMouseMove = throttle((e: MouseEvent) => {
      const wasInTriggerZone = isInTriggerZone;
      isInTriggerZone = e.clientY < 5;

      if (isInTriggerZone) {
        setIsHeaderVisible(true);
        if (hideTimeout !== null) {
          clearTimeout(hideTimeout);
          hideTimeout = null;
        }
      } else if (wasInTriggerZone) {
        if (hideTimeout !== null) clearTimeout(hideTimeout);
        hideTimeout = setTimeout(() => {
          setIsHeaderVisible(false);
        }, 2000);
      }
    }, 100);

    // Touch support for iOS PWA: double-tap anywhere or tap near top to show header.
    // Uses pointerdown (not touchstart) so we can ignore stylus/pen input (e.g. Apple
    // Pencil) via pointerType — otherwise pen strokes on the canvas are misread as
    // taps/double-taps and the header keeps sliding down while drawing.
    let lastTap = 0;
    const handlePointerDown = (e: PointerEvent) => {
      if (!e.isPrimary) return;
      if (e.pointerType !== 'touch') return;
      const y = e.clientY;
      const now = Date.now();
      const isDoubleTap = now - lastTap < 350;
      lastTap = now;

      // Tap near top (top 60px — above the Excalidraw toolbar on mobile) always shows.
      if (y < 60) {
        setIsHeaderVisible(true);
        if (hideTimeout !== null) {
          clearTimeout(hideTimeout);
          hideTimeout = null;
        }
        hideTimeout = setTimeout(() => {
          setIsHeaderVisible(false);
        }, 4000);
        return;
      }

      // Double-tap anywhere shows the header (useful in hand mode on canvas).
      if (isDoubleTap) {
        setIsHeaderVisible(true);
        if (hideTimeout !== null) {
          clearTimeout(hideTimeout);
          hideTimeout = null;
        }
        hideTimeout = setTimeout(() => {
          setIsHeaderVisible(false);
        }, 4000);
      }
    };

    setIsHeaderVisible(true);
    hideTimeout = setTimeout(() => {
      setIsHeaderVisible(false);
    }, 3000);

    window.addEventListener('mousemove', handleMouseMove, { passive: true });
    // Pointer listener only needed on touch/standalone devices. Uses pointerdown so
    // pen (Apple Pencil) and mouse input can be filtered out via pointerType.
    if (isStandalone() || 'ontouchstart' in window) {
      window.addEventListener('pointerdown', handlePointerDown, { passive: true });
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('pointerdown', handlePointerDown);
      if (hideTimeout !== null) clearTimeout(hideTimeout);
    };
  }, [autoHideEnabled, isRenaming]);

  return {
    isHeaderVisible,
    setIsHeaderVisible,
  };
};
