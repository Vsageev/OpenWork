import { useEffect, useRef, useState, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import styles from './NavigationProgress.module.css';

/**
 * Thin progress bar at the top of the viewport that animates during
 * route transitions, similar to NProgress / YouTube / GitHub.
 *
 * It listens for location changes and runs a fake-but-convincing
 * progress animation: jumps to ~15%, trickles up to ~85%, then
 * completes to 100% and fades out.
 */
export function NavigationProgress() {
  const location = useLocation();
  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);
  const prevPathRef = useRef(location.pathname);
  const trickleRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hideRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirstRender = useRef(true);

  const cleanup = useCallback(() => {
    if (trickleRef.current !== null) {
      clearInterval(trickleRef.current);
      trickleRef.current = null;
    }
    if (hideRef.current !== null) {
      clearTimeout(hideRef.current);
      hideRef.current = null;
    }
  }, []);

  useEffect(() => {
    // Skip the initial render — no navigation has occurred yet
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }

    // Only trigger on pathname changes (not hash/search changes)
    if (location.pathname === prevPathRef.current) return;
    prevPathRef.current = location.pathname;

    cleanup();

    // Start: jump to a visible amount immediately
    setVisible(true);
    setProgress(15);

    // Trickle: slowly increase progress
    trickleRef.current = setInterval(() => {
      setProgress((prev) => {
        if (prev >= 85) return prev;
        // Slow down as we approach 85%
        const increment = prev < 50 ? 8 : prev < 70 ? 3 : 1;
        return Math.min(prev + increment, 85);
      });
    }, 200);

    // Complete after a short delay (simulate page load finishing)
    // In practice, lazy components load fast since they're small chunks
    const completeTimeout = setTimeout(() => {
      cleanup();
      setProgress(100);

      // Fade out after the bar reaches 100%
      hideRef.current = setTimeout(() => {
        setVisible(false);
        setProgress(0);
      }, 300);
    }, 400);

    return () => {
      cleanup();
      clearTimeout(completeTimeout);
    };
  }, [location.pathname, cleanup]);

  // Cleanup on unmount
  useEffect(() => cleanup, [cleanup]);

  if (!visible && progress === 0) return null;

  return (
    <div
      className={styles.bar}
      style={{
        width: `${progress}%`,
        opacity: progress === 100 ? 0 : 1,
      }}
      role="progressbar"
      aria-valuenow={progress}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Page loading"
    />
  );
}
