import { SettingsStore } from '@feathertree/base-core';
import { DEFAULT_SETTINGS, normalizeSettings, type AppSettings } from './schema.js';

/**
 * FeatherTree の設定ストア。
 *
 * 永続化と正規化の仕組みは土台（@feathertree/base-core）にあり、
 * ここは FeatherTree 固有のスキーマと「最近開いたリポジトリ」の操作だけを足す。
 */
export class AppSettingsStore extends SettingsStore<AppSettings> {
  constructor(filePath: string) {
    super(filePath, normalizeSettings);
  }

  /** 最近開いたリポジトリの先頭へ移す。 */
  async touchRepository(root: string): Promise<AppSettings> {
    const rest = this.current.recentRepositories.filter((r) => r !== root);
    return this.update({ recentRepositories: [root, ...rest] });
  }
}

export { DEFAULT_SETTINGS };
