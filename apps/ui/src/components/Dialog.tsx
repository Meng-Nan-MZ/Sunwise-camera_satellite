import { useEffect, useRef, type ReactNode } from 'react';
export default function Dialog({
  title,
  onClose,
  children,
  busy = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="workbench-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !busy) onClose();
      }}
    >
      <div className="dialog-heading">
        <h2>{title}</h2>
        <button className="button" disabled={busy} onClick={onClose} aria-label="关闭对话框">
          关闭
        </button>
      </div>
      {children}
    </dialog>
  );
}
