import {
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import { createPortal } from 'react-dom';

type OverlayPlacement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';

interface AnchoredOverlayProps extends HTMLAttributes<HTMLDivElement> {
  anchorRef?: React.RefObject<HTMLElement | null>;
  anchorElement?: HTMLElement | null;
  anchorRect?: DOMRect | null;
  children: ReactNode;
  placement?: OverlayPlacement;
  offset?: number;
  matchAnchorWidth?: boolean;
  minWidth?: number;
  maxWidth?: number;
  zIndex?: number;
}

interface OverlayLayout {
  top: number;
  left: number;
  minWidth?: number;
  maxWidth?: number;
}

const VIEWPORT_PADDING = 8;

function clamp(value: number, min: number, max: number) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function resolvePortalContainer(anchor: HTMLElement | null, fallbackDocument: Document): Element | DocumentFragment {
  const rootNode = anchor?.getRootNode?.();
  if (rootNode && rootNode instanceof ShadowRoot) {
    return rootNode;
  }
  return anchor?.ownerDocument?.body ?? fallbackDocument.body;
}

export const AnchoredOverlay = forwardRef<HTMLDivElement, AnchoredOverlayProps>(function AnchoredOverlay(
  {
    anchorRef,
    anchorElement,
    anchorRect,
    children,
    placement = 'bottom-start',
    offset = 6,
    matchAnchorWidth = false,
    minWidth,
    maxWidth,
    zIndex = 1200,
    style,
    ...props
  },
  forwardedRef,
) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);
  const layoutRef = useRef<OverlayLayout | null>(null);
  const resolvedAnchor = anchorElement ?? anchorRef?.current ?? null;
  const portalContainer = useMemo(
    () => resolvePortalContainer(resolvedAnchor, document),
    [resolvedAnchor],
  );

  useImperativeHandle(forwardedRef, () => overlayRef.current as HTMLDivElement, []);

  const updatePosition = useCallback(() => {
    const anchor = resolvedAnchor;
    const fallbackRect = anchorRect ?? null;
    const overlay = overlayRef.current;
    if (!overlay) return;
    if (!anchor && !fallbackRect) return;
    if (anchor && !anchor.isConnected && !fallbackRect) return;

    const resolvedAnchorRect = anchor?.isConnected ? anchor.getBoundingClientRect() : fallbackRect;
    if (!resolvedAnchorRect) return;
    const overlayRect = overlay.getBoundingClientRect();
    const overlayWidth = overlayRect.width;
    const overlayHeight = overlayRect.height;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    const requestedVertical = placement.startsWith('top') ? 'top' : 'bottom';
    const requestedAlign = placement.endsWith('end') ? 'end' : 'start';

    const canFitBelow = resolvedAnchorRect.bottom + offset + overlayHeight <= viewportHeight - VIEWPORT_PADDING;
    const canFitAbove = resolvedAnchorRect.top - offset - overlayHeight >= VIEWPORT_PADDING;
    const vertical =
      requestedVertical === 'bottom'
        ? canFitBelow || !canFitAbove
          ? 'bottom'
          : 'top'
        : canFitAbove || !canFitBelow
          ? 'top'
          : 'bottom';

    const rawLeft =
      requestedAlign === 'end'
        ? resolvedAnchorRect.right - overlayWidth
        : resolvedAnchorRect.left;

    const rawTop =
      vertical === 'bottom'
        ? resolvedAnchorRect.bottom + offset
        : resolvedAnchorRect.top - overlayHeight - offset;

    const nextMaxWidth = maxWidth ?? viewportWidth - VIEWPORT_PADDING * 2;
    const maxLeft = viewportWidth - overlayWidth - VIEWPORT_PADDING;
    const maxTop = viewportHeight - overlayHeight - VIEWPORT_PADDING;
    const nextLayout: OverlayLayout = {
      left: clamp(rawLeft, VIEWPORT_PADDING, maxLeft),
      top: clamp(rawTop, VIEWPORT_PADDING, maxTop),
      minWidth: matchAnchorWidth ? resolvedAnchorRect.width : minWidth,
      maxWidth: nextMaxWidth,
    };
    const previousLayout = layoutRef.current;
    if (
      previousLayout &&
      previousLayout.left === nextLayout.left &&
      previousLayout.top === nextLayout.top &&
      previousLayout.minWidth === nextLayout.minWidth &&
      previousLayout.maxWidth === nextLayout.maxWidth
    ) {
      return;
    }

    layoutRef.current = nextLayout;
    overlay.style.left = `${nextLayout.left}px`;
    overlay.style.top = `${nextLayout.top}px`;
    overlay.style.minWidth = nextLayout.minWidth ? `${nextLayout.minWidth}px` : '';
    overlay.style.maxWidth = nextLayout.maxWidth ? `${nextLayout.maxWidth}px` : '';
    overlay.style.visibility = 'visible';
  }, [anchorRect, matchAnchorWidth, maxWidth, minWidth, offset, placement, resolvedAnchor]);

  useLayoutEffect(() => {
    updatePosition();

    const reposition = () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
      }
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        updatePosition();
      });
    };

    const anchor = resolvedAnchor;
    const scrollOptions = { capture: true, passive: true } as const;

    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, scrollOptions);

    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => reposition())
        : null;

    if (resizeObserver) {
      if (anchor?.isConnected) resizeObserver.observe(anchor);
      if (overlayRef.current) resizeObserver.observe(overlayRef.current);
    }

    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
      }
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, scrollOptions);
      resizeObserver?.disconnect();
    };
  }, [anchorRect, resolvedAnchor, updatePosition]);

  const overlayStyle: CSSProperties = {
    position: 'fixed',
    top: -9999,
    left: -9999,
    zIndex,
    visibility: 'hidden',
    ...style,
  };

  return createPortal(
    <div ref={overlayRef} style={overlayStyle} {...props}>
      {children}
    </div>,
    portalContainer,
  );
});
