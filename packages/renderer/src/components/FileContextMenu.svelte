<script lang="ts">
  interface Action {
    readonly label: string;
    readonly danger?: boolean;
    readonly onclick: () => void;
  }

  interface Props {
    x: number;
    y: number;
    actions: readonly Action[];
    onclose: () => void;
  }

  const { x, y, actions, onclose }: Props = $props();

  function run(action: Action): void {
    action.onclick();
    onclose();
  }
</script>

<!-- App.svelte のテーマメニューと同じ backdrop+menu の作り。クリック座標に固定表示する版。 -->
<div class="menu-backdrop" role="presentation" onclick={onclose} oncontextmenu={(e) => e.preventDefault()}></div>
<div class="menu" role="menu" style:top="{y}px" style:left="{x}px">
  {#each actions as action (action.label)}
    <button role="menuitem" class="menu-item" class:danger={action.danger === true} onclick={() => run(action)}>
      {action.label}
    </button>
  {/each}
</div>

<style>
  .menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: var(--app-layer-menu-backdrop);
  }

  .menu {
    position: fixed;
    z-index: var(--app-layer-menu);
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 4px;
    background: var(--app-bg-surface);
    border: 1px solid var(--app-border-strong);
    border-radius: var(--app-metric-radius);
    box-shadow: 0 8px 24px rgb(0 0 0 / 35%);
  }

  .menu-item {
    display: flex;
    align-items: center;
    white-space: nowrap;
    background: none;
    border: none;
    text-align: left;
    padding: 4px 10px;
  }

  .menu-item.danger {
    color: var(--app-text-danger);
  }
</style>
