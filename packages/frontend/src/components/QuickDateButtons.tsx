import styles from './QuickDateButtons.module.css';

function toDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getQuickDates() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const nextWeek = new Date(today);
  nextWeek.setDate(nextWeek.getDate() + 7);

  const nextMonth = new Date(today);
  nextMonth.setDate(nextMonth.getDate() + 30);

  return [
    { label: 'Today', value: toDateString(today) },
    { label: 'Tomorrow', value: toDateString(tomorrow) },
    { label: '+7d', value: toDateString(nextWeek) },
    { label: '+30d', value: toDateString(nextMonth) },
  ];
}

interface QuickDateButtonsProps {
  currentValue?: string;
  onSelect: (value: string) => void;
  disabled?: boolean;
  size?: 'sm' | 'md';
}

export function QuickDateButtons({ currentValue, onSelect, disabled, size = 'sm' }: QuickDateButtonsProps) {
  const options = getQuickDates();

  return (
    <div className={`${styles.quickDates} ${size === 'md' ? styles.quickDatesMd : ''}`}>
      {options.map((opt) => (
        <button
          key={opt.label}
          type="button"
          className={`${styles.quickDateBtn}${currentValue === opt.value ? ` ${styles.quickDateBtnActive}` : ''}`}
          onClick={() => onSelect(opt.value)}
          disabled={disabled}
          title={opt.value}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
