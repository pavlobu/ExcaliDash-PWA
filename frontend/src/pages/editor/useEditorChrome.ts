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
    let lastTap = 0;
    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const y = e.touches[0].clientY;
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
    // Touch listener only needed on touch/standalone devices.
    if (isStandalone() || 'ontouchstart' in window) {
      window.addEventListener('touchstart', handleTouchStart, { passive: true });
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('touchstart', handleTouchStart);
      if (hideTimeout !== null) clearTimeout(hideTimeout);
    };
  }, [autoHideEnabled, isRenaming]);

  return {
    isHeaderVisible,
    setIsHeaderVisible,
  };
};
