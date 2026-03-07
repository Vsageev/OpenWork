import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Eraser, FlipHorizontal2, FlipVertical2, Pencil, Plus, RefreshCw, RotateCcw, RotateCw, Trash2, Type, X } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Tooltip } from '../ui';
import styles from './AgentAvatar.module.css';

/* ── Icon shapes (16×16 grids, 1 = logo, 0 = background) ── */
/* prettier-ignore */
const ICONS: Record<string, { label: string; pattern: number[][] }> = {
  spark: {
    label: 'Spark',
    pattern: [
      [0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,0],
      [0,0,0,0,0,0,1,1,1,1,0,0,0,0,0,0],
      [0,0,0,0,0,0,1,1,1,1,0,0,0,0,0,0],
      [0,0,0,0,0,1,1,1,1,1,1,0,0,0,0,0],
      [0,0,0,0,0,1,1,1,1,1,1,0,0,0,0,0],
      [0,0,0,1,1,1,1,1,1,1,1,1,1,0,0,0],
      [0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0],
      [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
      [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
      [0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0],
      [0,0,0,1,1,1,1,1,1,1,1,1,1,0,0,0],
      [0,0,0,0,0,1,1,1,1,1,1,0,0,0,0,0],
      [0,0,0,0,0,1,1,1,1,1,1,0,0,0,0,0],
      [0,0,0,0,0,0,1,1,1,1,0,0,0,0,0,0],
      [0,0,0,0,0,0,1,1,1,1,0,0,0,0,0,0],
      [0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,0],
    ],
  },
  hexknot: {
    label: 'Knot',
    pattern: [
      [0,0,0,0,0,1,1,1,1,1,1,0,0,0,0,0],
      [0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0],
      [0,0,0,1,1,1,0,0,0,0,1,1,1,0,0,0],
      [0,0,1,1,1,0,0,0,0,0,0,1,1,1,0,0],
      [0,1,1,1,0,0,0,1,1,0,0,0,1,1,1,0],
      [1,1,1,0,0,0,1,1,1,1,0,0,0,1,1,1],
      [1,1,0,0,0,1,1,0,0,1,1,0,0,0,1,1],
      [1,1,0,0,1,1,0,0,0,0,1,1,0,0,1,1],
      [1,1,0,0,1,1,0,0,0,0,1,1,0,0,1,1],
      [1,1,0,0,0,1,1,0,0,1,1,0,0,0,1,1],
      [1,1,1,0,0,0,1,1,1,1,0,0,0,1,1,1],
      [0,1,1,1,0,0,0,1,1,0,0,0,1,1,1,0],
      [0,0,1,1,1,0,0,0,0,0,0,1,1,1,0,0],
      [0,0,0,1,1,1,0,0,0,0,1,1,1,0,0,0],
      [0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0],
      [0,0,0,0,0,1,1,1,1,1,1,0,0,0,0,0],
    ],
  },
  yinyang: {
    label: 'Flow',
    pattern: [
      [0,0,0,0,0,1,1,1,1,1,1,0,0,0,0,0],
      [0,0,0,1,1,1,1,1,1,1,1,1,1,0,0,0],
      [0,0,1,1,1,1,0,0,0,0,1,1,1,1,0,0],
      [0,1,1,1,0,0,0,0,0,0,0,0,1,1,1,0],
      [0,1,1,0,0,0,0,0,0,0,0,0,0,1,1,0],
      [1,1,1,0,0,1,1,1,0,0,0,0,0,1,1,1],
      [1,1,0,0,1,1,1,1,1,0,0,0,0,0,1,1],
      [1,1,0,0,1,1,1,1,1,0,0,0,0,0,1,1],
      [1,1,0,0,0,0,0,1,1,1,1,1,0,0,1,1],
      [1,1,0,0,0,0,0,1,1,1,1,1,0,0,1,1],
      [1,1,1,0,0,0,0,0,1,1,1,0,0,1,1,1],
      [0,1,1,0,0,0,0,0,0,0,0,0,0,1,1,0],
      [0,1,1,1,0,0,0,0,0,0,0,0,1,1,1,0],
      [0,0,1,1,1,1,0,0,0,0,1,1,1,1,0,0],
      [0,0,0,1,1,1,1,1,1,1,1,1,1,0,0,0],
      [0,0,0,0,0,1,1,1,1,1,1,0,0,0,0,0],
    ],
  },
  bolt: {
    label: 'Bolt',
    pattern: [
      [0,0,0,0,0,0,0,1,1,1,1,1,1,0,0,0],
      [0,0,0,0,0,0,1,1,1,1,1,1,0,0,0,0],
      [0,0,0,0,0,1,1,1,1,1,1,0,0,0,0,0],
      [0,0,0,0,1,1,1,1,1,1,0,0,0,0,0,0],
      [0,0,0,1,1,1,1,1,1,0,0,0,0,0,0,0],
      [0,0,1,1,1,1,1,1,0,0,0,0,0,0,0,0],
      [0,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0],
      [0,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0],
      [0,0,0,0,0,0,0,0,1,1,1,1,1,1,0,0],
      [0,0,0,0,0,0,0,1,1,1,1,1,1,0,0,0],
      [0,0,0,0,0,0,1,1,1,1,1,1,0,0,0,0],
      [0,0,0,0,0,1,1,1,1,1,1,0,0,0,0,0],
      [0,0,0,0,1,1,1,1,1,1,0,0,0,0,0,0],
      [0,0,0,1,1,1,1,1,1,0,0,0,0,0,0,0],
      [0,0,1,1,1,1,1,1,0,0,0,0,0,0,0,0],
      [0,0,0,1,1,1,0,0,0,0,0,0,0,0,0,0],
    ],
  },
  shield: {
    label: 'Shield',
    pattern: [
      [0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,0],
      [0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0],
      [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
      [1,1,1,0,0,0,0,1,1,0,0,0,0,1,1,1],
      [1,1,1,0,0,0,0,1,1,0,0,0,0,1,1,1],
      [1,1,1,0,0,0,0,1,1,0,0,0,0,1,1,1],
      [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
      [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
      [1,1,1,0,0,0,0,1,1,0,0,0,0,1,1,1],
      [0,1,1,0,0,0,0,1,1,0,0,0,0,1,1,0],
      [0,1,1,0,0,0,0,1,1,0,0,0,0,1,1,0],
      [0,0,1,1,0,0,0,1,1,0,0,0,1,1,0,0],
      [0,0,0,1,1,0,0,1,1,0,0,1,1,0,0,0],
      [0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0],
      [0,0,0,0,0,1,1,1,1,1,1,0,0,0,0,0],
      [0,0,0,0,0,0,1,1,1,1,0,0,0,0,0,0],
    ],
  },
  cube: {
    label: 'Cube',
    pattern: [
      [0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,0],
      [0,0,0,0,0,1,1,1,1,1,1,0,0,0,0,0],
      [0,0,0,1,1,1,1,1,1,1,1,1,1,0,0,0],
      [0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0],
      [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
      [1,1,1,1,1,1,1,0,0,1,1,1,1,1,1,1],
      [1,1,1,1,1,1,0,0,0,0,1,1,1,1,1,1],
      [1,1,1,1,1,0,0,0,0,0,0,1,1,1,1,1],
      [1,1,1,1,1,0,0,0,0,0,0,1,1,1,1,1],
      [1,1,1,1,1,1,0,0,0,0,1,1,1,1,1,1],
      [1,1,1,1,1,1,1,0,0,1,1,1,1,1,1,1],
      [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
      [0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0],
      [0,0,0,1,1,1,1,1,1,1,1,1,1,0,0,0],
      [0,0,0,0,0,1,1,1,1,1,1,0,0,0,0,0],
      [0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,0],
    ],
  },
};

const ICON_KEYS = Object.keys(ICONS);

function randomIcon(): string {
  const key = ICON_KEYS[Math.floor(Math.random() * ICON_KEYS.length)];
  return encodePattern(ICONS[key].pattern);
}

/* ── Custom pattern encoding (16×16 grid → "custom:<hex64>") ── */

const CUSTOM_PREFIX = 'custom:';
const GRID_SIZE = 16;

function encodePattern(grid: number[][]): string {
  let hex = '';
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x += 4) {
      const nibble =
        ((grid[y]?.[x] ? 1 : 0) << 3) |
        ((grid[y]?.[x + 1] ? 1 : 0) << 2) |
        ((grid[y]?.[x + 2] ? 1 : 0) << 1) |
        (grid[y]?.[x + 3] ? 1 : 0);
      hex += nibble.toString(16);
    }
  }
  return CUSTOM_PREFIX + hex;
}

function decodePattern(icon: string): number[][] | null {
  if (!icon.startsWith(CUSTOM_PREFIX)) return null;
  const hex = icon.slice(CUSTOM_PREFIX.length);
  if (hex.length !== 64) return null;
  const grid: number[][] = [];
  let idx = 0;
  for (let y = 0; y < GRID_SIZE; y++) {
    const row: number[] = [];
    for (let x = 0; x < GRID_SIZE; x += 4) {
      const nibble = parseInt(hex[idx++], 16);
      row.push((nibble >> 3) & 1, (nibble >> 2) & 1, (nibble >> 1) & 1, nibble & 1);
    }
    grid.push(row);
  }
  return grid;
}

function emptyGrid(): number[][] {
  return Array.from({ length: GRID_SIZE }, () => Array(GRID_SIZE).fill(0));
}

function isCustomIcon(icon: string): boolean {
  return icon.startsWith(CUSTOM_PREFIX);
}

/* ── Color generation ── */

const PALETTE = [
  // [background, logo]
  ['#1a1a2e', '#e94560'],
  ['#0f3460', '#e94560'],
  ['#16213e', '#0f3460'],
  ['#533483', '#e94560'],
  ['#2b2d42', '#ef233c'],
  ['#264653', '#2a9d8f'],
  ['#003049', '#fcbf49'],
  ['#1d3557', '#e63946'],
  ['#2d00f7', '#f20089'],
  ['#023e8a', '#48cae4'],
  ['#240046', '#c77dff'],
  ['#3c096c', '#ff6d00'],
  ['#10002b', '#e0aaff'],
  ['#1b4332', '#52b788'],
  ['#31572c', '#ecf39e'],
  ['#3a0ca3', '#f72585'],
  ['#001d3d', '#ffc300'],
  ['#14213d', '#fca311'],
  ['#000814', '#00b4d8'],
  ['#212529', '#f8f9fa'],
];

function randomPalette(): [string, string] {
  const idx = Math.floor(Math.random() * PALETTE.length);
  return PALETTE[idx] as [string, string];
}

/* ── Display component (canvas-based for crisp pixel art) ── */

interface AgentAvatarProps {
  icon: string;
  bgColor: string;
  logoColor: string;
  size?: number;
  className?: string;
}

export function AgentAvatar({ icon, bgColor, logoColor, size = 40, className }: AgentAvatarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const customPattern = useMemo(() => decodePattern(icon), [icon]);
  const pattern = customPattern ?? (ICONS[icon] ?? ICONS.spark).pattern;
  const gridSize = pattern.length;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const scale = Math.max(Math.ceil(size / gridSize), 1) * dpr;
    const px = scale;

    canvas.width = gridSize * px;
    canvas.height = gridSize * px;

    // Background
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Logo pixels
    ctx.fillStyle = logoColor;
    for (let y = 0; y < gridSize; y++) {
      for (let x = 0; x < gridSize; x++) {
        if (pattern[y][x]) {
          ctx.fillRect(x * px, y * px, px, px);
        }
      }
    }
  }, [pattern, bgColor, logoColor, gridSize, size]);

  return (
    <canvas
      ref={canvasRef}
      className={`${styles.avatar} ${className ?? ''}`}
      style={{ width: size, height: size }}
    />
  );
}

/* ── Icon Drawing Modal ── */

interface IconDrawingModalProps {
  initialGrid: number[][];
  bgColor: string;
  logoColor: string;
  onSave: (icon: string, name: string) => void | Promise<void>;
  onClose: () => void;
}

function IconDrawingModal({ initialGrid, bgColor, logoColor, onSave, onClose }: IconDrawingModalProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [grid, setGrid] = useState<number[][]>(() => initialGrid.map((r) => [...r]));
  const [tool, setTool] = useState<'draw' | 'erase'>('draw');
  const [undoStack, setUndoStack] = useState<number[][][]>([]);
  const [redoStack, setRedoStack] = useState<number[][][]>([]);
  const [presetName, setPresetName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const painting = useRef(false);
  const lastCell = useRef<[number, number] | null>(null);
  const strokeStart = useRef<number[][] | null>(null);

  const cellSize = 20;
  const canvasSize = cellSize * GRID_SIZE;

  // Draw the canvas
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvasSize * dpr;
    canvas.height = canvasSize * dpr;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, canvasSize, canvasSize);

    ctx.fillStyle = logoColor;
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        if (grid[y][x]) {
          ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
        }
      }
    }

    ctx.strokeStyle = 'rgba(128, 128, 128, 0.18)';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= GRID_SIZE; i++) {
      ctx.beginPath();
      ctx.moveTo(i * cellSize, 0);
      ctx.lineTo(i * cellSize, canvasSize);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, i * cellSize);
      ctx.lineTo(canvasSize, i * cellSize);
      ctx.stroke();
    }
  }, [grid, bgColor, logoColor, canvasSize]);

  useEffect(() => { draw(); }, [draw]);

  const getCell = useCallback((e: React.MouseEvent<HTMLCanvasElement>): [number, number] => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * GRID_SIZE);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * GRID_SIZE);
    return [Math.max(0, Math.min(GRID_SIZE - 1, x)), Math.max(0, Math.min(GRID_SIZE - 1, y))];
  }, []);

  const applyTool = useCallback((x: number, y: number) => {
    if (lastCell.current && lastCell.current[0] === x && lastCell.current[1] === y) return;
    lastCell.current = [x, y];
    const newVal = tool === 'draw' ? 1 : 0;
    if (grid[y][x] === newVal) return;
    const next = grid.map((row) => [...row]);
    next[y][x] = newVal;
    setGrid(next);
  }, [grid, tool]);

  const handlePointerDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    painting.current = true;
    lastCell.current = null;
    strokeStart.current = grid.map((r) => [...r]);
    const [x, y] = getCell(e);
    applyTool(x, y);
  }, [getCell, applyTool, grid]);

  const handlePointerMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!painting.current) return;
    const [x, y] = getCell(e);
    applyTool(x, y);
  }, [getCell, applyTool]);

  const handlePointerUp = useCallback(() => {
    const strokeSnapshot = strokeStart.current ? strokeStart.current.map((row) => [...row]) : null;
    if (painting.current && strokeSnapshot) {
      setUndoStack((s) => [...s, strokeSnapshot]);
      setRedoStack([]);
    }
    painting.current = false;
    lastCell.current = null;
    strokeStart.current = null;
  }, []);

  const pushUndo = useCallback((g: number[][]) => {
    setUndoStack((s) => [...s, g]);
    setRedoStack([]);
  }, []);

  const handleUndo = useCallback(() => {
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1].map((row) => [...row]);
    setUndoStack((s) => s.slice(0, -1));
    setRedoStack((s) => [...s, grid.map((r) => [...r])]);
    setGrid(prev);
  }, [undoStack, grid]);

  const handleRedo = useCallback(() => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1].map((row) => [...row]);
    setRedoStack((s) => s.slice(0, -1));
    setUndoStack((s) => [...s, grid.map((r) => [...r])]);
    setGrid(next);
  }, [redoStack, grid]);

  const handleClear = useCallback(() => {
    pushUndo(grid.map((r) => [...r]));
    setGrid(emptyGrid());
  }, [grid, pushUndo]);

  const handleFlipH = useCallback(() => {
    pushUndo(grid.map((r) => [...r]));
    setGrid(grid.map((row) => [...row].reverse()));
  }, [grid, pushUndo]);

  const handleFlipV = useCallback(() => {
    pushUndo(grid.map((r) => [...r]));
    setGrid([...grid].reverse().map((r) => [...r]));
  }, [grid, pushUndo]);

  const handleLoadPreset = useCallback((key: string) => {
    pushUndo(grid.map((r) => [...r]));
    setGrid(ICONS[key].pattern.map((r) => [...r]));
  }, [grid, pushUndo]);

  // Keyboard shortcuts
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleUndo, handleRedo]);

  const hasPixels = grid.some((row) => row.some((v) => v === 1));

  const handleSave = useCallback(async () => {
    const name = presetName.trim();
    if (!hasPixels || saving || !name) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(encodePattern(grid), name);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Failed to save icon');
    } finally {
      setSaving(false);
    }
  }, [grid, hasPixels, onSave, saving, presetName]);

  return (
    <Modal onClose={onClose} size="lg" ariaLabel="Create shape preset">
      <div className={styles.drawModalContent}>
        <div className={styles.drawModalHeader}>
          <h3 className={styles.drawModalTitle}>New Shape Preset</h3>
          <button type="button" className={styles.drawModalCloseBtn} onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className={styles.drawModalBody}>
          {/* Toolbar */}
          <div className={styles.drawModalToolbar}>
            <div className={styles.drawModalToolGroup}>
              <Tooltip label="Draw (pencil)">
                <button
                  type="button"
                  className={`${styles.drawToolBtn} ${tool === 'draw' ? styles.drawToolBtnActive : ''}`}
                  onClick={() => setTool('draw')}
                  aria-label="Draw"
                >
                  <Pencil size={15} />
                </button>
              </Tooltip>
              <Tooltip label="Erase">
                <button
                  type="button"
                  className={`${styles.drawToolBtn} ${tool === 'erase' ? styles.drawToolBtnActive : ''}`}
                  onClick={() => setTool('erase')}
                  aria-label="Erase"
                >
                  <Eraser size={15} />
                </button>
              </Tooltip>
            </div>

            <div className={styles.drawModalToolDivider} />

            <div className={styles.drawModalToolGroup}>
              <Tooltip label="Undo">
                <button type="button" className={styles.drawToolBtn} onClick={handleUndo} disabled={undoStack.length === 0} aria-label="Undo">
                  <RotateCcw size={15} />
                </button>
              </Tooltip>
              <Tooltip label="Redo">
                <button type="button" className={styles.drawToolBtn} onClick={handleRedo} disabled={redoStack.length === 0} aria-label="Redo">
                  <RotateCw size={15} />
                </button>
              </Tooltip>
            </div>

            <div className={styles.drawModalToolDivider} />

            <div className={styles.drawModalToolGroup}>
              <Tooltip label="Flip horizontal">
                <button type="button" className={styles.drawToolBtn} onClick={handleFlipH} aria-label="Flip horizontal">
                  <FlipHorizontal2 size={15} />
                </button>
              </Tooltip>
              <Tooltip label="Flip vertical">
                <button type="button" className={styles.drawToolBtn} onClick={handleFlipV} aria-label="Flip vertical">
                  <FlipVertical2 size={15} />
                </button>
              </Tooltip>
            </div>

            <div className={styles.drawToolbarSpacer} />

            <Tooltip label="Clear canvas">
              <button type="button" className={styles.drawToolBtn} onClick={handleClear} aria-label="Clear canvas">
                <Trash2 size={15} />
              </button>
            </Tooltip>
          </div>

          {/* Canvas + Preview side by side */}
          <div className={styles.drawModalCanvasRow}>
            <canvas
              ref={canvasRef}
              className={styles.drawingCanvas}
              style={{ width: canvasSize, height: canvasSize }}
              onMouseDown={handlePointerDown}
              onMouseMove={handlePointerMove}
              onMouseUp={handlePointerUp}
              onMouseLeave={handlePointerUp}
            />
            <div className={styles.drawModalSidebar}>
              <div className={styles.drawModalPreviewSection}>
                <span className={styles.drawModalSideLabel}>Preview</span>
                <div className={styles.drawModalPreviewSizes}>
                  <AgentAvatar icon={encodePattern(grid)} bgColor={bgColor} logoColor={logoColor} size={56} />
                  <AgentAvatar icon={encodePattern(grid)} bgColor={bgColor} logoColor={logoColor} size={36} />
                  <AgentAvatar icon={encodePattern(grid)} bgColor={bgColor} logoColor={logoColor} size={24} />
                </div>
              </div>
              <div className={styles.drawModalPresetsSection}>
                <span className={styles.drawModalSideLabel}>Start from template</span>
                <div className={styles.drawModalPresetsGrid}>
                  {ICON_KEYS.map((key) => (
                    <Tooltip key={key} label={ICONS[key].label}>
                      <button
                        type="button"
                        className={styles.drawModalPresetBtn}
                        onClick={() => handleLoadPreset(key)}
                        aria-label={ICONS[key].label}
                      >
                        <AgentAvatar icon={key} bgColor={bgColor} logoColor={logoColor} size={24} />
                      </button>
                    </Tooltip>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {saveError ? <div className={styles.drawModalError}>{saveError}</div> : null}

        <div className={styles.drawModalFooter}>
          <input
            value={presetName}
            onChange={(e) => setPresetName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleSave(); }}
            placeholder="Preset name"
            className={styles.drawModalNameInput}
            maxLength={80}
            autoFocus
          />
          <button type="button" className={styles.drawModalCancelBtn} onClick={onClose} disabled={saving}>Cancel</button>
          <button
            type="button"
            className={styles.drawModalSaveBtn}
            disabled={!hasPixels || saving || !presetName.trim()}
            onClick={() => {
              void handleSave();
            }}
          >
            <Check size={15} />
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ── Picker / creator component ── */

export interface AvatarConfig {
  icon: string;
  bgColor: string;
  logoColor: string;
}

export interface SavedAvatarPreset {
  id: string;
  name: string;
  avatarIcon: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface SavedColorPreset {
  id: string;
  name: string;
  bgColor: string;
  logoColor: string;
  createdAt?: string;
  updatedAt?: string;
}

interface AgentAvatarPickerProps {
  value: AvatarConfig;
  onChange: (config: AvatarConfig) => void | Promise<void>;
  savedPresets?: SavedAvatarPreset[];
  onCreatePreset?: (input: { name: string; icon: string }) => void | Promise<void>;
  onRenamePreset?: (id: string, name: string) => void | Promise<void>;
  onDeletePreset?: (id: string) => void | Promise<void>;
  savedColorPresets?: SavedColorPreset[];
  onCreateColorPreset?: (input: { name: string; bgColor: string; logoColor: string }) => void | Promise<void>;
  onDeleteColorPreset?: (id: string) => void | Promise<void>;
}

function normalizeIcon(icon: string): string {
  if (ICONS[icon]) return encodePattern(ICONS[icon].pattern);
  return icon;
}

function isSameShape(leftIcon: string, rightIcon: string): boolean {
  return normalizeIcon(leftIcon) === normalizeIcon(rightIcon);
}

export function AgentAvatarPicker({
  value,
  onChange,
  savedPresets = [],
  onCreatePreset,
  onRenamePreset,
  onDeletePreset,
  savedColorPresets = [],
  onCreateColorPreset,
  onDeleteColorPreset,
}: AgentAvatarPickerProps) {
  const [showPalettes, setShowPalettes] = useState(false);
  const [drawingOpen, setDrawingOpen] = useState(false);
  const [drawInitGrid, setDrawInitGrid] = useState<number[][]>(emptyGrid);
  const [presetError, setPresetError] = useState<string | null>(null);
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [editingPresetName, setEditingPresetName] = useState('');
  const [renamingPresetId, setRenamingPresetId] = useState<string | null>(null);
  const [deletingPresetId, setDeletingPresetId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [addingColorPreset, setAddingColorPreset] = useState(false);
  const [newColorPresetName, setNewColorPresetName] = useState('');
  const [savingColorPreset, setSavingColorPreset] = useState(false);
  const [colorPresetError, setColorPresetError] = useState<string | null>(null);
  const [deletingColorPresetId, setDeletingColorPresetId] = useState<string | null>(null);

  const randomize = useCallback(() => {
    const [bg, logo] = randomPalette();
    onChange({ ...value, bgColor: bg, logoColor: logo, icon: randomIcon() });
  }, [onChange, value]);

  const handleOpenDrawing = useCallback(() => {
    setDrawInitGrid(emptyGrid());
    setDrawingOpen(true);
  }, []);

  const handleDrawingSave = useCallback(async (icon: string, name: string) => {
    if (onCreatePreset) {
      await onCreatePreset({ name, icon });
    }
    await onChange({ ...value, icon });
    setDrawingOpen(false);
  }, [onChange, onCreatePreset, value]);

  const handleApplySavedPreset = useCallback((preset: SavedAvatarPreset) => {
    onChange({
      icon: preset.avatarIcon,
      bgColor: value.bgColor,
      logoColor: value.logoColor,
    });
  }, [onChange, value.bgColor, value.logoColor]);

  const beginRenamePreset = useCallback((preset: SavedAvatarPreset, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setEditingPresetId(preset.id);
    setEditingPresetName(preset.name);
    setPresetError(null);
  }, []);

  const handleRenameSavedPreset = useCallback(async (presetId: string) => {
    if (!onRenamePreset || renamingPresetId) return;
    const name = editingPresetName.trim();
    if (!name) {
      setPresetError('Preset name is required');
      return;
    }
    setRenamingPresetId(presetId);
    setPresetError(null);
    try {
      await onRenamePreset(presetId, name);
      setEditingPresetId(null);
      setEditingPresetName('');
    } catch (error) {
      setPresetError(error instanceof Error ? error.message : 'Failed to rename preset');
    } finally {
      setRenamingPresetId(null);
    }
  }, [editingPresetName, onRenamePreset, renamingPresetId]);

  const handleDeleteSavedPreset = useCallback(async (presetId: string) => {
    if (!onDeletePreset || deletingPresetId) return;
    setDeletingPresetId(presetId);
    setPresetError(null);
    try {
      await onDeletePreset(presetId);
      if (editingPresetId === presetId) {
        setEditingPresetId(null);
        setEditingPresetName('');
      }
    } catch (error) {
      setPresetError(error instanceof Error ? error.message : 'Failed to delete preset');
    } finally {
      setDeletingPresetId(null);
    }
  }, [deletingPresetId, editingPresetId, onDeletePreset]);

  const handleCreateColorPreset = useCallback(async () => {
    if (!onCreateColorPreset || savingColorPreset) return;
    const name = newColorPresetName.trim();
    if (!name) {
      setColorPresetError('Preset name is required');
      return;
    }
    setSavingColorPreset(true);
    setColorPresetError(null);
    try {
      await onCreateColorPreset({ name, bgColor: value.bgColor, logoColor: value.logoColor });
      setAddingColorPreset(false);
      setNewColorPresetName('');
    } catch (error) {
      setColorPresetError(error instanceof Error ? error.message : 'Failed to save color preset');
    } finally {
      setSavingColorPreset(false);
    }
  }, [newColorPresetName, onCreateColorPreset, savingColorPreset, value.bgColor, value.logoColor]);

  const handleDeleteColorPreset = useCallback(async (presetId: string) => {
    if (!onDeleteColorPreset || deletingColorPresetId) return;
    setDeletingColorPresetId(presetId);
    setColorPresetError(null);
    try {
      await onDeleteColorPreset(presetId);
    } catch (error) {
      setColorPresetError(error instanceof Error ? error.message : 'Failed to delete color preset');
    } finally {
      setDeletingColorPresetId(null);
    }
  }, [deletingColorPresetId, onDeleteColorPreset]);

  const preview = useMemo(
    () => <AgentAvatar icon={value.icon} bgColor={value.bgColor} logoColor={value.logoColor} size={64} />,
    [value.icon, value.bgColor, value.logoColor],
  );

  return (
    <div className={styles.picker}>
      <div className={styles.pickerPreview}>
        {preview}
        <Tooltip label="Randomize avatar">
          <button type="button" className={styles.randomBtn} onClick={randomize} aria-label="Randomize avatar">
            <RefreshCw size={14} />
          </button>
        </Tooltip>
      </div>

      {/* Shapes grid — built-in + saved presets + draw/add */}
      <div className={styles.shapesGrid}>
        {/* Built-in shapes (permanent, not manageable) */}
        {ICON_KEYS.map((key) => {
          const icon = ICONS[key];
          const encoded = encodePattern(icon.pattern);
          const selected = isSameShape(value.icon, encoded);

          return (
            <button
              key={key}
              type="button"
              className={`${styles.shapeCard} ${selected ? styles.shapeCardActive : ''}`}
              onClick={() => onChange({ ...value, icon: encoded })}
              aria-label={`Apply ${icon.label}`}
            >
              <AgentAvatar icon={key} bgColor={value.bgColor} logoColor={value.logoColor} size={28} />
              <span className={styles.shapeCardLabel}>{icon.label}</span>
            </button>
          );
        })}

        {/* Saved presets (manageable — rename, replace, delete) */}
        {savedPresets.map((preset) => {
          const selected = isSameShape(value.icon, preset.avatarIcon);
          const isEditing = editingPresetId === preset.id;
          const isConfirmingDelete = confirmDeleteId === preset.id;

          return (
            <div
              key={preset.id}
              className={`${styles.shapeCard} ${styles.shapeCardManageable} ${selected ? styles.shapeCardActive : ''} ${isEditing || isConfirmingDelete ? styles.shapeCardEditing : ''}`}
            >
              {!isEditing && !isConfirmingDelete && (
                <button
                  type="button"
                  className={styles.shapeCardBtn}
                  onClick={() => handleApplySavedPreset(preset)}
                  aria-label={`Apply ${preset.name}`}
                >
                  <AgentAvatar icon={preset.avatarIcon} bgColor={value.bgColor} logoColor={value.logoColor} size={28} />
                  <span className={styles.shapeCardLabel}>{preset.name}</span>
                </button>
              )}

              {/* Hover actions */}
              {!isEditing && !isConfirmingDelete && (
                <div className={styles.shapeCardActions}>
                  {onRenamePreset && (
                    <Tooltip label="Rename">
                      <button
                        type="button"
                        className={styles.shapeActionBtn}
                        onClick={(e) => beginRenamePreset(preset, e)}
                        aria-label="Rename"
                      >
                        <Type size={12} />
                      </button>
                    </Tooltip>
                  )}
                  {onDeletePreset && (
                    <Tooltip label="Delete">
                      <button
                        type="button"
                        className={`${styles.shapeActionBtn} ${styles.shapeActionBtnDanger}`}
                        onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(preset.id); }}
                        aria-label="Delete"
                      >
                        <Trash2 size={12} />
                      </button>
                    </Tooltip>
                  )}
                </div>
              )}

              {/* Inline rename */}
              {isEditing && (
                <div className={styles.shapeInlineEdit} onClick={(e) => e.stopPropagation()}>
                  <AgentAvatar icon={preset.avatarIcon} bgColor={value.bgColor} logoColor={value.logoColor} size={24} />
                  <input
                    value={editingPresetName}
                    onChange={(event) => setEditingPresetName(event.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleRenameSavedPreset(preset.id);
                      if (e.key === 'Escape') { setEditingPresetId(null); setEditingPresetName(''); }
                    }}
                    className={styles.shapeInlineInput}
                    placeholder="Preset name"
                    maxLength={80}
                    autoFocus
                  />
                  <button type="button" className={styles.shapeInlineBtn} onClick={() => { void handleRenameSavedPreset(preset.id); }} disabled={renamingPresetId === preset.id}>
                    <Check size={14} />
                  </button>
                  <button type="button" className={styles.shapeInlineBtn} onClick={() => { setEditingPresetId(null); setEditingPresetName(''); setPresetError(null); }}>
                    <X size={14} />
                  </button>
                </div>
              )}

              {/* Delete confirmation */}
              {isConfirmingDelete && (
                <div className={styles.shapeDeleteConfirm} onClick={(e) => e.stopPropagation()}>
                  <span className={styles.shapeDeleteText}>Delete?</span>
                  <button type="button" className={`${styles.shapeInlineBtn} ${styles.shapeActionBtnDanger}`} onClick={() => { void handleDeleteSavedPreset(preset.id); setConfirmDeleteId(null); }} disabled={deletingPresetId === preset.id}>
                    <Check size={12} />
                  </button>
                  <button type="button" className={styles.shapeInlineBtn} onClick={() => setConfirmDeleteId(null)}>
                    <X size={12} />
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {/* Add new shape preset */}
        {onCreatePreset && (
          <button
            type="button"
            className={`${styles.shapeCard} ${styles.shapeCardAction}`}
            onClick={handleOpenDrawing}
            aria-label="Add new shape preset"
          >
            <Plus size={16} />
            <span className={styles.shapeCardLabel}>Add</span>
          </button>
        )}
      </div>

      {presetError ? <div className={styles.shapeError}>{presetError}</div> : null}

      {/* Drawing modal */}
      {drawingOpen && (
        <IconDrawingModal
          initialGrid={drawInitGrid}
          bgColor={value.bgColor}
          logoColor={value.logoColor}
          onSave={handleDrawingSave}
          onClose={() => setDrawingOpen(false)}
        />
      )}

      <div className={styles.pickerControls}>
        <label className={styles.colorField}>
          <span className={styles.colorLabel}>Background</span>
          <div className={styles.colorInputWrap}>
            <input
              type="color"
              value={value.bgColor}
              onChange={(e) => onChange({ ...value, bgColor: e.target.value })}
              className={styles.colorInput}
            />
            <span className={styles.colorHex}>{value.bgColor}</span>
          </div>
        </label>
        <label className={styles.colorField}>
          <span className={styles.colorLabel}>Logo</span>
          <div className={styles.colorInputWrap}>
            <input
              type="color"
              value={value.logoColor}
              onChange={(e) => onChange({ ...value, logoColor: e.target.value })}
              className={styles.colorInput}
            />
            <span className={styles.colorHex}>{value.logoColor}</span>
          </div>
        </label>
      </div>

      <button
        type="button"
        className={styles.palettesToggle}
        onClick={() => setShowPalettes((s) => !s)}
      >
        {showPalettes ? 'Hide color presets' : 'Color presets'}
      </button>

      {showPalettes && (
        <>
          <div className={styles.palettesGrid}>
            {/* Built-in palettes */}
            {PALETTE.map(([bg, logo]) => (
              <Tooltip key={`${bg}-${logo}`} label={`${bg} / ${logo}`}>
                <button
                  type="button"
                  className={`${styles.paletteBtn} ${value.bgColor === bg && value.logoColor === logo ? styles.paletteBtnActive : ''}`}
                  onClick={() => onChange({ ...value, bgColor: bg, logoColor: logo })}
                  aria-label={`${bg} / ${logo}`}
                >
                  <span className={styles.paletteSwatch} style={{ background: bg }}>
                    <span className={styles.paletteInner} style={{ background: logo }} />
                  </span>
                </button>
              </Tooltip>
            ))}

            {/* Saved color presets */}
            {savedColorPresets.map((cp) => {
              const isActive = value.bgColor === cp.bgColor && value.logoColor === cp.logoColor;

              return (
                <div key={cp.id} className={styles.colorPresetItem}>
                  <Tooltip label={cp.name}>
                    <button
                      type="button"
                      className={`${styles.paletteBtn} ${isActive ? styles.paletteBtnActive : ''}`}
                      onClick={() => onChange({ ...value, bgColor: cp.bgColor, logoColor: cp.logoColor })}
                      aria-label={cp.name}
                    >
                      <span className={styles.paletteSwatch} style={{ background: cp.bgColor }}>
                        <span className={styles.paletteInner} style={{ background: cp.logoColor }} />
                      </span>
                    </button>
                  </Tooltip>
                  {onDeleteColorPreset && (
                    <button
                      type="button"
                      className={styles.colorPresetDeleteBtn}
                      onClick={() => void handleDeleteColorPreset(cp.id)}
                      disabled={deletingColorPresetId === cp.id}
                      aria-label={`Delete ${cp.name}`}
                    >
                      <X size={10} />
                    </button>
                  )}
                </div>
              );
            })}

            {/* Add color preset button */}
            {onCreateColorPreset && !addingColorPreset && (
              <Tooltip label="Save current colors as preset">
                <button
                  type="button"
                  className={`${styles.paletteBtn} ${styles.paletteAddBtn}`}
                  onClick={() => { setColorPresetError(null); setNewColorPresetName(''); setAddingColorPreset(true); }}
                  aria-label="Save color preset"
                >
                  <Plus size={14} />
                </button>
              </Tooltip>
            )}
          </div>

          {/* Inline add color preset form */}
          {addingColorPreset && onCreateColorPreset && (
            <div className={styles.shapeAddForm}>
              <span className={styles.paletteSwatch} style={{ background: value.bgColor }}>
                <span className={styles.paletteInner} style={{ background: value.logoColor }} />
              </span>
              <input
                value={newColorPresetName}
                onChange={(e) => setNewColorPresetName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleCreateColorPreset();
                  if (e.key === 'Escape') { setAddingColorPreset(false); setNewColorPresetName(''); }
                }}
                placeholder="Preset name"
                className={styles.shapeInlineInput}
                maxLength={80}
                autoFocus
              />
              <button
                type="button"
                className={styles.shapeAddConfirmBtn}
                onClick={() => { void handleCreateColorPreset(); }}
                disabled={savingColorPreset || !newColorPresetName.trim()}
              >
                {savingColorPreset ? '...' : 'Save'}
              </button>
              <button type="button" className={styles.shapeInlineBtn} onClick={() => { setAddingColorPreset(false); setNewColorPresetName(''); setColorPresetError(null); }}>
                <X size={14} />
              </button>
            </div>
          )}

          {colorPresetError ? <div className={styles.shapeError}>{colorPresetError}</div> : null}
        </>
      )}

    </div>
  );
}

export { randomPalette, randomIcon, ICONS, encodePattern };
