import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface TaskMenuPosition {
  id: string;
  x: number;
  y: number;
  anchor: HTMLButtonElement;
}

export default function TaskContextMenu({
  position,
  onClose,
  onDelete,
}: {
  position: TaskMenuPosition;
  onClose: () => void;
  onDelete: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [point, setPoint] = useState({ x: position.x, y: position.y });
  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    setPoint({
      x: Math.max(8, Math.min(position.x, innerWidth - rect.width - 8)),
      y: Math.max(8, Math.min(position.y, innerHeight - rect.height - 8)),
    });
    ref.current?.querySelector('button')?.focus();
  }, [position]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const close = () => onClose();
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [onClose]);
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="任务操作"
      className="task-context-menu"
      style={{ left: point.x, top: point.y }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault();
          onClose();
          position.anchor.focus();
        }
      }}
    >
      <button role="menuitem" className="danger" onClick={() => onDelete(position.id)}>
        删除任务及文件…
      </button>
    </div>,
    document.body,
  );
}
