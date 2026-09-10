<script lang="ts">
  interface Props {
    value: number;
    min: number;
    max: number;
    onchange: (next: number) => void;
    oncommit: (next: number) => void;
  }

  const { value, min, max, onchange, oncommit }: Props = $props();

  let dragStartX = 0;
  let dragStartValue = 0;
  let dragging = false;

  function clamp(n: number): number {
    return Math.min(max, Math.max(min, n));
  }

  function handlePointerDown(event: PointerEvent): void {
    dragging = true;
    dragStartX = event.clientX;
    dragStartValue = value;
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: PointerEvent): void {
    if (!dragging) return;
    onchange(clamp(dragStartValue + (event.clientX - dragStartX)));
  }

  function handlePointerUp(event: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    const target = event.currentTarget as HTMLElement;
    target.releasePointerCapture(event.pointerId);
    oncommit(clamp(dragStartValue + (event.clientX - dragStartX)));
  }
</script>

<!--
  ファイル一覧（WorkingTreePane）と差分（DiffPane）の境界を任意の幅にドラッグできる分割線。
  ドラッグ中は onchange で即時プレビューし、pointerup で oncommit（永続化）を一度だけ呼ぶ
  （ドラッグ中に settingsUpdate を都度送らないため）。
-->
<div
  class="splitter"
  role="separator"
  aria-orientation="vertical"
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

  .splitter:hover,
  .splitter:active {
    background: var(--app-border-strong);
  }
</style>
