/**
 * Tiny async mutex (promise chain). Used to serialize clip renders:
 * Render's free tier has 0.1 CPU, so two concurrent ffmpeg renders
 * would starve each other and risk timeouts/OOM.
 */
export function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = tail;
    tail = gate;
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}
