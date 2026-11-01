import { useId, useState } from 'react';
import { imageCountError } from '../imageCount';
import type { RenderJobMode } from '../types';

const presets = [100, 500, 1000] as const;

interface Props {
  mode: RenderJobMode;
  count: number;
  setCount: (value: number) => void;
}

export default function ImageCountControls({ mode, count, setCount }: Props) {
  const inputId = useId();
  // Track the selection separately: typing 100 must still leave Custom selected.
  const [selection, setSelection] = useState({
    count,
    custom: !presets.some((preset) => preset === count),
  });
  if (!Object.is(selection.count, count)) {
    setSelection({ count, custom: !presets.some((preset) => preset === count) });
  }
  const error = imageCountError(mode, count);

  function changeCount(value: number, custom: boolean) {
    setSelection({ count: value, custom });
    setCount(value);
  }

  return (
    <section className="control-section image-count-controls">
      <label className="count-label" htmlFor={inputId}>
        生成图片数量（张）
      </label>
      <div className="count-presets" role="group" aria-label="图片数量快捷选择">
        {presets.map((preset) => (
          <button
            key={preset}
            type="button"
            className={`count-preset${!selection.custom && count === preset ? ' active' : ''}`}
            aria-pressed={!selection.custom && count === preset}
            onClick={() => changeCount(preset, false)}
          >
            {preset}
          </button>
        ))}
        <button
          type="button"
          className={`count-preset${selection.custom ? ' active' : ''}`}
          aria-pressed={selection.custom}
          onClick={() => setSelection({ count, custom: true })}
        >
          自定义
        </button>
      </div>
      <div className="count-input">
        <input
          id={inputId}
          aria-label="采集数量"
          type="number"
          min={mode === 'custom_sequence' ? 2 : 1}
          max={100000}
          step={1}
          value={Number.isFinite(count) ? count : ''}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${inputId}-error` : undefined}
          onChange={(event) => changeCount(event.target.valueAsNumber, true)}
        />
        <span className="count-unit">张</span>
      </div>
      {error && (
        <p className="count-error" id={`${inputId}-error`} role="status">
          {error}
        </p>
      )}
    </section>
  );
}
