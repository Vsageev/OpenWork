import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
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
  return ICON_KEYS[Math.floor(Math.random() * ICON_KEYS.length)];
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
  const entry = ICONS[icon] ?? ICONS.spark;
  const pattern = entry.pattern;
  const gridSize = pattern.length;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = gridSize;
    canvas.height = gridSize;

    // Background
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, gridSize, gridSize);

    // Logo pixels
    ctx.fillStyle = logoColor;
    for (let y = 0; y < gridSize; y++) {
      for (let x = 0; x < gridSize; x++) {
        if (pattern[y][x]) {
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }
  }, [pattern, bgColor, logoColor, gridSize]);

  return (
    <canvas
      ref={canvasRef}
      className={`${styles.avatar} ${className ?? ''}`}
      style={{ width: size, height: size }}
    />
  );
}

/* ── Picker / creator component ── */

export interface AvatarConfig {
  icon: string;
  bgColor: string;
  logoColor: string;
}

interface AgentAvatarPickerProps {
  value: AvatarConfig;
  onChange: (config: AvatarConfig) => void;
}

export function AgentAvatarPicker({ value, onChange }: AgentAvatarPickerProps) {
  const [showPalettes, setShowPalettes] = useState(false);

  const randomize = useCallback(() => {
    const [bg, logo] = randomPalette();
    onChange({ ...value, bgColor: bg, logoColor: logo, icon: randomIcon() });
  }, [onChange, value]);

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

      {/* Icon shape picker */}
      <div className={styles.iconGrid}>
        {ICON_KEYS.map((key) => (
          <Tooltip key={key} label={ICONS[key].label}>
            <button
              type="button"
              className={`${styles.iconOption} ${value.icon === key ? styles.iconOptionActive : ''}`}
              onClick={() => onChange({ ...value, icon: key })}
              aria-label={ICONS[key].label}
            >
              <AgentAvatar icon={key} bgColor={value.bgColor} logoColor={value.logoColor} size={28} />
            </button>
          </Tooltip>
        ))}
      </div>

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
        {showPalettes ? 'Hide presets' : 'Color presets'}
      </button>

      {showPalettes && (
        <div className={styles.palettesGrid}>
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
        </div>
      )}
    </div>
  );
}

export { randomPalette, randomIcon };
