import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * JSON 設定ファイルの読み書き。
 *
 * 土台としての約束:
 *   - **保存先のパスは外部から注入する。** ポータブル判定や userData の解決は
 *     electron 側の責務なので、この層は electron を知らない
 *   - 未作成・壊れた JSON でも既定値で続行する（起動を止めない）
 *   - 書き込みは一時ファイル経由で差し替える（途中で壊れた設定を残さない）
 *
 * 正規化関数を注入することで、アプリ固有の設定スキーマから独立させている。
 */
export class SettingsStore<T> {
  readonly #filePath: string;
  readonly #normalize: (raw: unknown) => T;
  #current: T;
  #loaded = false;

  constructor(filePath: string, normalize: (raw: unknown) => T) {
    this.#filePath = filePath;
    this.#normalize = normalize;
    this.#current = normalize(undefined);
  }

  get filePath(): string {
    return this.#filePath;
  }

  get current(): T {
    return this.#current;
  }

  async load(): Promise<T> {
    try {
      const text = await readFile(this.#filePath, 'utf8');
      this.#current = this.#normalize(JSON.parse(text));
    } catch {
      // 未作成・壊れた JSON はどちらも既定値で続行する
      this.#current = this.#normalize(undefined);
    }
    this.#loaded = true;
    return this.#current;
  }

  async update(patch: Partial<T>): Promise<T> {
    if (!this.#loaded) await this.load();
    this.#current = this.#normalize({ ...this.#current, ...patch });
    await this.#persist();
    return this.#current;
  }

  async #persist(): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true });
    // 書き込み途中で壊れないよう一時ファイル経由で差し替える
    const tmp = `${this.#filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(this.#current, null, 2), 'utf8');
    await rename(tmp, this.#filePath);
  }
}
