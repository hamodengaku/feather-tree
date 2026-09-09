import { createBridgeProxy } from '@feathertree/base-ui';
import type { FeatherTreeBridge } from '@feathertree/ipc';

declare global {
  interface Window {
    readonly ft: FeatherTreeBridge;
  }
}

/**
 * preload が公開した API。renderer から外界への唯一の出口。
 *
 * 遅延解決なので読み込み時点では window を参照しない
 * （AppState に偽のブリッジを注入してテストできる）。
 */
export const ft: FeatherTreeBridge = createBridgeProxy<FeatherTreeBridge>('ft');
