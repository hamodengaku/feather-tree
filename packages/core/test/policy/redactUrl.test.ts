import { describe, expect, it } from 'vitest';
import { redactUrl } from '../../src/policy/redactUrl.js';

describe('redactUrl（クローン URL の資格情報マスク、脆弱性診断 §11）', () => {
  it('https + user:token を伏せる', () => {
    expect(redactUrl('https://user:TOKEN@host/repo.git')).toBe('https://***@host/repo.git');
  });

  it('https + user のみ（パスワード無し）でも userinfo は伏せる', () => {
    expect(redactUrl('https://user@host/repo.git')).toBe('https://***@host/repo.git');
  });

  it('userinfo が無い https URL はそのまま', () => {
    expect(redactUrl('https://host/repo.git')).toBe('https://host/repo.git');
  });

  it('scp 形式（user@host:path）は伏せない（ssh のユーザー名でパスワードではない）', () => {
    expect(redactUrl('git@github.com:owner/repo.git')).toBe('git@github.com:owner/repo.git');
  });

  it('ssh:// の完全な URL は https と同様に userinfo を伏せる', () => {
    expect(redactUrl('ssh://git@host:22/owner/repo.git')).toBe('ssh://***@host:22/owner/repo.git');
  });

  it('不正な文字列でも例外を投げず、そのまま返す', () => {
    expect(redactUrl('')).toBe('');
    expect(redactUrl('not a url at all')).toBe('not a url at all');
    expect(redactUrl('https://')).toBe('https://');
    expect(() => redactUrl('://@@@///:::')).not.toThrow();
  });

  it('URL の外側（パス部分）に @ があっても伏せない', () => {
    expect(redactUrl('https://host/path@2/file')).toBe('https://host/path@2/file');
  });

  it('自由形式の文章中に埋まっていても検出して伏せる（git の stderr 相当）', () => {
    const stderr = "fatal: unable to access 'https://user:TOKEN@host/repo.git/': The requested URL returned error: 403";
    const result = redactUrl(stderr);
    expect(result).not.toContain('TOKEN');
    expect(result).toContain("https://***@host/repo.git/");
  });

  it('複数の URL が含まれていてもすべて伏せる', () => {
    const text = 'a=https://u1:p1@h1/x b=https://u2:p2@h2/y';
    expect(redactUrl(text)).toBe('a=https://***@h1/x b=https://***@h2/y');
  });

  it('冪等（すでに伏せた文字列に再度適用しても変わらない）', () => {
    const once = redactUrl('https://user:TOKEN@host/repo.git');
    expect(redactUrl(once)).toBe(once);
  });
});
