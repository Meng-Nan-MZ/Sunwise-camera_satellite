import { useEffect, useState } from 'react';
import { errorMessage, renderBridgeApi } from './api.ts';
import { FormalRenderer } from './formalRenderer.ts';
import { runRenderBridge } from './renderBridge.ts';
/** Registered independently of live model/mode/preview changes. */
export function useRenderBridge() {
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let renderer: FormalRenderer | undefined;
    setError('');
    const stop = () => {
      controller.abort();
      renderer?.dispose();
    };
    window.addEventListener('pagehide', stop);
    try {
      renderer = new FormalRenderer(() => {
        setError('网页正式采集的显卡上下文已丢失，请重新连接。');
        stop();
      });
      void runRenderBridge(renderBridgeApi, renderer, controller.signal).catch(
        (failure: unknown) => {
          if (!controller.signal.aborted) setError(errorMessage(failure));
        },
      );
    } catch (failure) {
      setError(errorMessage(failure));
      stop();
    }
    return () => {
      window.removeEventListener('pagehide', stop);
      stop();
    };
  }, [retry]);
  return { error, retry: () => setRetry((value) => value + 1) };
}
