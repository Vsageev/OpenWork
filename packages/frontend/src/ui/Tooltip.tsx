import {
  type FocusEvent,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import styles from './Tooltip.module.css';

type TooltipPosition = 'top' | 'bottom' | 'left' | 'right';
type TooltipCoords = { top: number; left: number; placement: TooltipPosition };

interface TooltipProps {
  label: string;
  position?: TooltipPosition;
  children: ReactNode;
}

const GAP = 6;
const VIEWPORT_PADDING = 8;

const oppositePlacement: Record<TooltipPosition, TooltipPosition> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
};

function clamp(value: number, min: number, max: number) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function getRawCoords(anchorRect: DOMRect, tooltipRect: DOMRect, placement: TooltipPosition) {
  switch (placement) {
    case 'top':
      return {
        top: anchorRect.top - tooltipRect.height - GAP,
        left: anchorRect.left + anchorRect.width / 2 - tooltipRect.width / 2,
      };
    case 'bottom':
      return {
        top: anchorRect.bottom + GAP,
        left: anchorRect.left + anchorRect.width / 2 - tooltipRect.width / 2,
      };
    case 'left':
      return {
        top: anchorRect.top + anchorRect.height / 2 - tooltipRect.height / 2,
        left: anchorRect.left - tooltipRect.width - GAP,
      };
    case 'right':
    default:
      return {
        top: anchorRect.top + anchorRect.height / 2 - tooltipRect.height / 2,
        left: anchorRect.right + GAP,
      };
  }
}

function overflowScore(left: number, top: number, tooltipRect: DOMRect) {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const right = left + tooltipRect.width;
  const bottom = top + tooltipRect.height;

  return (
    Math.max(0, VIEWPORT_PADDING - left) +
    Math.max(0, VIEWPORT_PADDING - top) +
    Math.max(0, right - (viewportWidth - VIEWPORT_PADDING)) +
    Math.max(0, bottom - (viewportHeight - VIEWPORT_PADDING))
  );
}

function computeCoords(
  anchorRect: DOMRect,
  tooltipRect: DOMRect,
  preferredPlacement: TooltipPosition,
): TooltipCoords {
  const orderedPlacements = Array.from(
    new Set<TooltipPosition>([
      preferredPlacement,
      oppositePlacement[preferredPlacement],
      'top',
      'bottom',
      'left',
      'right',
    ]),
  );

  let bestPlacement = preferredPlacement;
  let bestLeft = 0;
  let bestTop = 0;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const placement of orderedPlacements) {
    const raw = getRawCoords(anchorRect, tooltipRect, placement);
    const score = overflowScore(raw.left, raw.top, tooltipRect);

    if (score < bestScore) {
      bestScore = score;
      bestPlacement = placement;
      bestLeft = raw.left;
      bestTop = raw.top;
    }

    if (score === 0) break;
  }

  const maxLeft = window.innerWidth - tooltipRect.width - VIEWPORT_PADDING;
  const maxTop = window.innerHeight - tooltipRect.height - VIEWPORT_PADDING;

  return {
    placement: bestPlacement,
    left: clamp(bestLeft, VIEWPORT_PADDING, maxLeft),
    top: clamp(bestTop, VIEWPORT_PADDING, maxTop),
  };
}

export function Tooltip({ label, position = 'top', children }: TooltipProps) {
  const wrapperRef = useRef<HTMLDivElement | HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [coords, setCoords] = useState<TooltipCoords | null>(null);

  const updatePosition = useCallback(() => {
    if (!wrapperRef.current || !tooltipRef.current) return;

    const anchorRect = wrapperRef.current.getBoundingClientRect();
    const tooltipRect = tooltipRef.current.getBoundingClientRect();
    const nextCoords = computeCoords(anchorRect, tooltipRect, position);

    setCoords((prev) => {
      if (
        prev &&
        prev.placement === nextCoords.placement &&
        Math.abs(prev.left - nextCoords.left) < 0.5 &&
        Math.abs(prev.top - nextCoords.top) < 0.5
      ) {
        return prev;
      }
      return nextCoords;
    });
  }, [position]);

  useLayoutEffect(() => {
    if (!isOpen) return;

    updatePosition();

    const reposition = () => {
      window.requestAnimationFrame(updatePosition);
    };

    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);

    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [isOpen, updatePosition]);

  const openTooltip = () => setIsOpen(true);
  const closeTooltip = () => {
    setIsOpen(false);
    setCoords(null);
  };

  const handleBlur = (event: FocusEvent<HTMLDivElement | HTMLSpanElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      closeTooltip();
    }
  };

  return (
    <span
      ref={wrapperRef}
      className={styles.wrapper}
      onMouseEnter={openTooltip}
      onMouseLeave={closeTooltip}
      onFocus={openTooltip}
      onBlur={handleBlur}
    >
      {children}
      {isOpen &&
        typeof document !== 'undefined' &&
        createPortal(
          <span
            ref={tooltipRef}
            className={`${styles.tip} ${coords ? styles.visible : ''}`}
            data-placement={coords?.placement ?? position}
            role="tooltip"
            style={{
              left: coords?.left ?? -9999,
              top: coords?.top ?? -9999,
            }}
          >
            {label}
          </span>,
          document.body,
        )}
    </span>
  );
}
