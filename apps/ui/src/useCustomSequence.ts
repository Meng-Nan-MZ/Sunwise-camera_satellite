import { useEffect, useMemo, useState } from 'react';
import { quaternionFromEuler } from './scene';
import {
  advancePreview,
  samplePreview,
  toClientQuaternion,
  validateFrameCount,
} from './trajectory';
import type { EulerTuple, QuaternionTuple } from './types';

export function useCustomSequence(enabled: boolean, count: number, modelId: string) {
  const [start, setStart] = useState<EulerTuple>([0, 0, 0]);
  const [end, setEnd] = useState<EulerTuple>([90, 0, 0]);
  const [preview, setPreview] = useState({ active: false, playing: false, frame: 0, key: '' });
  const key = JSON.stringify([enabled, count, modelId, start, end]);
  const configuration = useMemo(() => {
    try {
      validateFrameCount(count);
      return { start: quaternionFromEuler(start), end: quaternionFromEuler(end), error: '' };
    } catch (error) {
      return { start: null, end: null, error: error instanceof Error ? error.message : '姿态无效' };
    }
  }, [start, end, count]);
  useEffect(() => {
    setPreview({ active: false, playing: false, frame: 0, key: '' });
  }, [key]);
  const active = enabled && preview.key === key && preview.active && !configuration.error;
  const playing = active && preview.playing;
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(
      () => setPreview((previous) => advancePreview(previous, key, count)),
      100,
    );
    return () => window.clearInterval(timer);
  }, [playing, count, key]);
  const frame = active ? preview.frame : 0;
  const quaternion: QuaternionTuple | null =
    active && configuration.start && configuration.end
      ? samplePreview(configuration.start, configuration.end, count, frame)
      : null;
  return {
    start,
    end,
    setStart,
    setEnd,
    active,
    playing,
    frame,
    quaternion,
    startQuaternion: configuration.start,
    endQuaternion: configuration.end,
    error: configuration.error,
    trajectory:
      configuration.start && configuration.end
        ? {
            start_quat: toClientQuaternion(configuration.start),
            end_quat: toClientQuaternion(configuration.end),
            time_step_s: 1,
          }
        : undefined,
    play: () =>
      setPreview({
        active: true,
        playing: true,
        frame: active && frame < count - 1 ? frame : 0,
        key,
      }),
    pause: () => setPreview((previous) => ({ ...previous, playing: false })),
    scrub: (frame: number) => setPreview({ active: true, playing: false, frame, key }),
    exit: () => setPreview({ active: false, playing: false, frame: 0, key: '' }),
  };
}
