// An element's size, kept in state as it changes: read when its observer reports it, once laid out, never as the
// element mounts (which `bind:clientHeight` and the like do, laying the whole page out then and there).

export function sized(read: (el: HTMLElement) => number, set: (n: number) => void) {
  return (el: HTMLElement) => {
    const ro = new ResizeObserver(() => set(read(el)));
    ro.observe(el, { box: 'border-box' });
    return () => ro.disconnect();
  };
}
