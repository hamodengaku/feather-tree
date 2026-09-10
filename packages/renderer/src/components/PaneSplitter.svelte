<script lang="ts">
  interface Props {
    value: number;
    min: number;
    max: number;
    /** 分割線がどちら向きにドラッグを検知するか。'x' は左右（列の分割）、'y' は上下（行の分割）。 */
    axis?: 'x' | 'y';
    /** true なら値とドラッグ方向を逆にする（例: 下端パネルの上端にある分割線を上へ引くと大きくなる）。 */
    invert?: boolean;
    onchange: (next: number) => void;
    oncommit: (next: number) => void;
  }

  const { value, min, max, axis = 'x', invert = false, onchange, oncommit }: Props = $props();

  let dragStart = 0;
  let dragStartValue = 0;
  let dragging = false;

  function pos(event: PointerEvent): number {
    return axis === 'x' ? event.clientX : event.clientY;
  }

  function clamp(n: number): number {
    return Math.min(max, Math.max(min, n));
  }

  function next(event: PointerEvent): number {
    const delta = pos(event) - dragStart;
    return clamp(dragStartValue + (invert ? -delta : delta));
  }

  function handlePointerDown(event: PointerEvent): void {
    dragging = true;
    dragStart = pos(event);
    dragStartValue = value;
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: PointerEvent): void {
    if (!dragging) return;
    onchange(next(event));
  }

  function handlePointerUp(event: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    const target = event.currentTarget as HTMLElement;
    target.releasePointerCapture(event.pointerId);
    oncommit(next(event));
  }
</script>

<!--
  隣接する2ペインの境界を任意のサイズにドラッグできる分割線。
  ドラッグ中は onchange で即時プレビューし、pointerup で oncommit（永続化）を一度だけ呼ぶ
  （ドラッグ中に settingsUpdate を都度送らないため）。
-->
<div
  class="splitter"
  class:axis-y={axis === 'y'}
  role="separator"
  aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
  tabindex="-1"
  onpointerdown={handlePointerDown}
  onpointermove={handlePointerMove}
  onpointerup={handlePointerUp}
></div>

<style>
  .splitter {
    width: 6px;
    cursor: col-resize;
    background: transparent;
    touch-action: none;
  }

  .splitter.axis-y {
    width: auto;
    height: 6px;
    cursor: row-resize;
  }

  .splitter:hover,
  .splitter:active {
    background: var(--app-border-strong);
  }
</style>
