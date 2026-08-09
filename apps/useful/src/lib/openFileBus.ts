export type OpenFileDetail = { toolId: string; file: string };

type Listener = (detail: OpenFileDetail) => void;

const listeners = new Set<Listener>();
let pending: OpenFileDetail | null = null;

/** Dispatch an open-file request; queue it if the target view is not mounted yet. */
export function requestOpenFile(detail: OpenFileDetail): void {
  if (listeners.size === 0) {
    pending = detail;
    return;
  }
  for (const listener of listeners) listener(detail);
}

/** Subscribe to open-file requests. Immediately drains any pending request. */
export function subscribeOpenFile(listener: Listener): () => void {
  listeners.add(listener);
  if (pending) {
    const detail = pending;
    pending = null;
    listener(detail);
  }
  return () => {
    listeners.delete(listener);
  };
}
