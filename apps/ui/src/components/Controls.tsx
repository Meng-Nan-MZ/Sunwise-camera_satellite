import { useId } from 'react';

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (value: number) => void;
  disabled?: boolean;
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  unit = '',
  onChange,
  disabled,
}: SliderProps) {
  const id = useId();
  return (
    <div className={`slider-field${disabled ? ' disabled' : ''}`}>
      <div className="field-heading">
        <label htmlFor={id}>{label}</label>
        <div className="number-with-unit">
          <input
            aria-label={`${label}数值`}
            type="number"
            min={min}
            max={max}
            step={step}
            value={value}
            disabled={disabled}
            onChange={(event) => {
              if (event.target.value !== '' && Number.isFinite(event.target.valueAsNumber))
                onChange(Math.min(max, Math.max(min, event.target.valueAsNumber)));
            }}
          />
          <span>{unit}</span>
        </div>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.valueAsNumber)}
        style={{ '--fill': `${((value - min) / (max - min)) * 100}%` } as React.CSSProperties}
      />
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <label className="toggle-label">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="toggle-track" aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}

export function SatelliteIcon({ small = false }: { small?: boolean }) {
  return (
    <svg
      width={small ? 24 : 32}
      height={small ? 24 : 32}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <g transform="rotate(-28 16 16)" stroke="currentColor" strokeWidth="1.3">
        <path d="M13 11h6v10h-6zM3 12h7v8H3zM22 12h7v8h-7zM10 16h3m6 0h3M6.5 12v8m19-8v8M3 16h7m12 0h7M16 11V8m0 0-3-3m3 3 3-3" />
        <circle cx="16" cy="16" r="1.5" />
      </g>
    </svg>
  );
}
