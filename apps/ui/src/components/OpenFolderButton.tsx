import { useEffect, useRef, useState } from 'react';
import { nativeFolderBridge } from '../outputDirectory';
import { openOutputFolder } from '../openOutputFolder';
import { errorMessage } from '../api';
export default function OpenFolderButton({
  jobId,
  label = '打开文件夹',
}: {
  jobId?: string;
  label?: string;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  async function open() {
    if (pending.current) return;
    const c = new AbortController();
    pending.current = c;
    setBusy(true);
    setError('');
    try {
      await openOutputFolder(nativeFolderBridge(), jobId, c.signal);
    } catch (e) {
      if (!c.signal.aborted) setError(errorMessage(e));
    } finally {
      pending.current = null;
      if (!c.signal.aborted) setBusy(false);
    }
  }
  return (
    <span className="open-folder">
      <button className="button" disabled={busy} onClick={() => void open()}>
        {busy ? '正在打开…' : label}
      </button>
      {error && (
        <span className="folder-open-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
