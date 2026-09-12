import { mount } from 'svelte';
import '@feathertree/base-ui/src/base.css';
import './theme/tokens.css';
import Splash from './Splash.svelte';
import { applyTheme } from './lib/theme.js';
import type { SettingsDto } from '@feathertree/ipc';

/**
 * スプラッシュのエントリ（決定 28）。renderer の 2 つ目の入力。
 *
 * **このウィンドウは preload を持たないので `window.ft` が無い。** IPC は一切使えない。
 * 必要な値（テーマとバージョン）は main がクエリ文字列で渡してくる。
 */

type ThemeName = SettingsDto['theme'];

const THEMES: readonly ThemeName[] = ['classic-dark', 'classic-light', 'phoenix-dark', 'phoenix-light'];

/** クエリのテーマ名。main が渡すので普通は正しいが、不正なら既定へ落として起動を止めない。 */
function readTheme(params: URLSearchParams): ThemeName {
  const raw = params.get('theme');
  return THEMES.find((t) => t === raw) ?? 'phoenix-light';
}

const params = new URLSearchParams(location.search);
const theme = readTheme(params);

// 本体と同じ関数でトークンを流し込む。これで色が完全に一致し、
// フェザー系のマーブル背景（起動ごとに乱数で決まる）もそのまま付いてくる。
applyTheme(theme);

const target = document.getElementById('splash');
if (!target) throw new Error('#splash が見つかりません');

mount(Splash, { target, props: { version: params.get('version') ?? '' } });
