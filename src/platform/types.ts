/** Runtime capabilities needed by watch-mode scheduling. */
export type Platform = {
  readonly name: 'node' | 'browser';
  readonly scheduleIdle: (callback: () => void) => () => void;
};
