/*
 * テーマ（`xl/theme/theme1.xml`）の色の読み取り（決定 33 の M2）。
 *
 * 読むのは `<a:clrScheme>` の 12 色だけ（dk1, lt1, dk2, lt2, accent1〜6, hlink, folHlink の順）。
 * 各色は `<a:srgbClr val="RRGGBB"/>` か `<a:sysClr val="windowText" lastClr="000000"/>` で書かれる。
 * 読めない色は Office の既定テーマの色で埋める。
 */

import { XML_END, XML_EOF, XML_START, XmlScanner } from '../xml/scanner.js';
import { DEFAULT_THEME, normalizeRgb } from './colors.js';

const SLOTS = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];

export function parseTheme(bytes: Uint8Array): string[] {
  const out = [...DEFAULT_THEME];
  const x = new XmlScanner(bytes);
  let inScheme = false;
  let slot = -1;
  for (let k = x.next(); k !== XML_EOF; k = x.next()) {
    if (k === XML_START) {
      if (x.nameIs('clrScheme')) {
        inScheme = !x.selfClosing;
        continue;
      }
      if (!inScheme) continue;
      const name = x.name();
      const at = SLOTS.indexOf(name);
      if (at >= 0) {
        slot = at;
        continue;
      }
      if (slot >= 0 && (x.nameIs('srgbClr') || x.nameIs('sysClr'))) {
        const value = normalizeRgb(x.nameIs('srgbClr') ? x.attr('val') : x.attr('lastClr'));
        if (value !== null) out[slot] = value;
      }
    } else if (k === XML_END) {
      if (x.nameIs('clrScheme')) inScheme = false;
      else if (inScheme && SLOTS.includes(x.name())) slot = -1;
    }
  }
  return out;
}
