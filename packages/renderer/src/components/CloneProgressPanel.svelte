<script lang="ts">
  import type { CloneStageDto } from '@feathertree/ipc';
  import { STATE_LABEL, STATE_MARK, barText, headingBefore, stageTime } from '../lib/cloneProgressView.js';

  let { stages, running }: { stages: readonly CloneStageDto[]; running: boolean } = $props();

  /** 経過時間の表示に使う時刻。実行中だけ 1 秒ごとに進める（段階表の到着とは独立に数字を動かす）。 */
  let now = $state(Date.now());
  /** 実行中の行を自動で追うか。利用者が自分でスクロールしたら追うのをやめる。 */
  let follow = $state(true);
  let list = $state<HTMLOListElement | undefined>(undefined);

  $effect(() => {
    if (!running) return;
    now = Date.now();
    const timer = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => clearInterval(timer);
  });

  /*
   * 手でのスクロールの検出。scroll イベントは scrollIntoView でも発火して区別できないので、
   * 利用者の操作（ホイール・つかむ・キー）だけを見る。要素にハンドラ属性を付けると
   * 非対話要素への a11y 警告になるので、ここで直接つなぐ。
   */
  $effect(() => {
    const element = list;
    if (element === undefined) return;
    const stop = (): void => {
      follow = false;
    };
    element.addEventListener('wheel', stop, { passive: true });
    element.addEventListener('pointerdown', stop);
    element.addEventListener('touchstart', stop, { passive: true });
    return () => {
      element.removeEventListener('wheel', stop);
      element.removeEventListener('pointerdown', stop);
      element.removeEventListener('touchstart', stop);
    };
  });

  $effect(() => {
    const active = stages.find((s) => s.state === 'running');
    if (!follow || active === undefined || list === undefined) return;
    list.querySelector(`[data-stage="${active.id}"]`)?.scrollIntoView({ block: 'nearest' });
  });

  function fillWidth(stage: CloneStageDto): string {
    if (stage.state === 'done') return '100%';
    return String(stage.percent ?? 0) + '%';
  }
</script>

<!--
  クローンの段階別の進捗（決定 9）。段階は始まる前にすべて並び、上から順に 100% まで進む。
  状態遷移は main（core の cloneProgress.ts）が持ち、ここは届いた表を描くだけ。
-->
<ol class="stages" bind:this={list} aria-label="クローンの進捗">
  {#each stages as stage, index (stage.id)}
    {@const heading = headingBefore(stages, index)}
    {#if heading !== null}
      <li class="group" aria-hidden="true">{heading}</li>
    {/if}
    <li class="stage {stage.state}" data-stage={stage.id}>
      <span class="mark" aria-hidden="true">{STATE_MARK[stage.state]}</span>
      <span class="visually-hidden">{STATE_LABEL[stage.state]}</span>
      <span class="name" title={stage.label + '（' + stage.source + '）'}>
        {stage.label}<span class="source">（{stage.source}）</span>
      </span>
      <span class="bar" class:indeterminate={stage.state === 'running' && stage.percent === null}>
        <span class="fill" style:width={fillWidth(stage)}></span>
        <span class="bar-text">{stage.state === 'skipped' ? '省略' : barText(stage)}</span>
      </span>
      <span class="time">{stageTime(stage, now)}</span>
    </li>
  {/each}
</ol>

<style>
  .stages {
    display: grid;
    grid-template-columns: 1.2em minmax(0, 15em) minmax(0, 1fr) 5.5em;
    align-items: center;
    gap: 4px 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  /* 行は grid の子を横に並べるだけの器（行ごとに列をそろえる）。 */
  .stage {
    display: contents;
  }

  .group {
    grid-column: 1 / -1;
    margin-top: 6px;
    padding-bottom: 2px;
    border-bottom: 1px solid var(--app-border-subtle);
    color: var(--app-text-muted);
    font-size: var(--app-font-size-mono);
  }

  .group:first-child {
    margin-top: 0;
  }

  .mark {
    text-align: center;
    color: var(--app-text-muted);
  }

  .stage.running .mark {
    color: var(--app-accent);
  }

  .stage.failed .mark,
  .stage.failed .name {
    color: var(--app-accent);
    font-weight: 600;
  }

  .name {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--app-text-secondary);
  }

  .stage.pending .name,
  .stage.skipped .name,
  .stage.cancelled .name {
    color: var(--app-text-muted);
  }

  .source {
    color: var(--app-text-muted);
    font-size: var(--app-font-size-mono);
  }

  /* バーの中に件数・転送量を重ねて、行の高さを増やさない。 */
  .bar {
    position: relative;
    height: 18px;
    overflow: hidden;
    background: var(--app-bg-raised);
    border: 1px solid var(--app-border-subtle);
    border-radius: var(--app-metric-radius);
  }

  .fill {
    position: absolute;
    inset: 0 auto 0 0;
    background: color-mix(in srgb, var(--app-accent) 35%, transparent);
    transition: width 200ms linear;
  }

  .stage.done .fill {
    background: color-mix(in srgb, var(--app-text-muted) 30%, transparent);
  }

  /* 件数しか分からない段階（対象の列挙など）は、止まっていないことだけを流れる帯で示す。 */
  .bar.indeterminate .fill {
    width: 30% !important;
    animation: clone-indeterminate 1.4s ease-in-out infinite;
  }

  @keyframes clone-indeterminate {
    from {
      left: -30%;
    }
    to {
      left: 100%;
    }
  }

  .bar-text {
    position: relative;
    display: block;
    padding: 0 6px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    line-height: 16px;
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
    color: var(--app-text-secondary);
  }

  .time {
    text-align: right;
    font-family: var(--app-font-mono);
    font-size: var(--app-font-size-mono);
    color: var(--app-text-muted);
    white-space: nowrap;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  @media (prefers-reduced-motion: reduce) {
    .fill {
      transition: none;
    }

    .bar.indeterminate .fill {
      left: 0;
      width: 100% !important;
      animation: clone-indeterminate-pulse 1.6s ease-in-out infinite;
    }

    @keyframes clone-indeterminate-pulse {
      50% {
        opacity: 0.35;
      }
    }
  }
</style>
