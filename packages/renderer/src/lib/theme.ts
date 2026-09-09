import { applyTokens, type ThemeTokens } from '@feathertree/base-ui';
import type { SettingsDto } from '@feathertree/ipc';

/**
 * FeatherTree のパレット。
 *
 * 適用の仕組み（style.setProperty で流し込む）は土台の applyTokens にある。
 * ここが持つのは「どんな色にするか」だけ。
 */

const DARK: ThemeTokens = {
  '--app-bg-app': '#1b1d21',
  '--app-bg-surface': '#23262b',
  '--app-bg-raised': '#2b2f35',
  '--app-bg-hover': '#2f343b',
  '--app-bg-selected': '#33465c',
  '--app-border-subtle': '#33373d',
  '--app-border-strong': '#454b53',
  '--app-text-primary': '#e6e8ea',
  '--app-text-secondary': '#9ba1a8',
  '--app-text-muted': '#6f767e',
  '--app-text-added': '#7fce7f',
  '--app-text-removed': '#e07a7a',
  '--app-text-modified': '#d8c169',
  '--app-text-untracked': '#8ab4d8',
  '--app-text-conflict': '#e0a05c',
  '--app-text-danger': '#e05c5c',
  '--app-accent': '#5b9dd9',
  '--app-diff-added-bg': '#1e2f22',
  '--app-diff-removed-bg': '#33211f',
  '--app-scheme': 'dark',
};

const LIGHT: ThemeTokens = {
  '--app-bg-app': '#f5f6f7',
  '--app-bg-surface': '#ffffff',
  '--app-bg-raised': '#eceef0',
  '--app-bg-hover': '#e6e9ec',
  '--app-bg-selected': '#cfe0f2',
  '--app-border-subtle': '#dcdfe3',
  '--app-border-strong': '#b9bec5',
  '--app-text-primary': '#1f2328',
  '--app-text-secondary': '#5a6169',
  '--app-text-muted': '#8a9199',
  '--app-text-added': '#1a7f37',
  '--app-text-removed': '#c0392b',
  '--app-text-modified': '#9a6700',
  '--app-text-untracked': '#2b6cb0',
  '--app-text-conflict': '#bf6516',
  '--app-text-danger': '#c0392b',
  '--app-accent': '#2b6cb0',
  '--app-diff-added-bg': '#e6f6ea',
  '--app-diff-removed-bg': '#fdeceb',
  '--app-scheme': 'light',
};

export const THEMES: Readonly<Record<SettingsDto['theme'], ThemeTokens>> = { dark: DARK, light: LIGHT };

export function applyTheme(theme: SettingsDto['theme'], root?: HTMLElement): void {
  applyTokens(THEMES[theme], { ...(root === undefined ? {} : { root }), colorScheme: theme });
}
