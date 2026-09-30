import { describe, expect, it } from 'vitest';
import { XML_END, XML_EOF, XML_START, XML_TEXT, XmlScanner } from '../src/xml/scanner.js';
import { unescapeOoxml, unescapeXml } from '../src/xml/entities.js';

const scan = (xml: string): XmlScanner => new XmlScanner(new TextEncoder().encode(xml));

/** 走査結果を読みやすい列にする。 */
function events(xml: string): string[] {
  const x = scan(xml);
  const out: string[] = [];
  for (let k = x.next(); k !== XML_EOF; k = x.next()) {
    if (k === XML_START) out.push(`<${x.name()}${x.selfClosing ? '/' : ''}>`);
    else if (k === XML_END) out.push(`</${x.name()}>`);
    else if (k === XML_TEXT) out.push(JSON.stringify(x.text()));
  }
  return out;
}

describe('XML の走査器（決定 33）', () => {
  it('要素・自己終了・文字を順に返し、接頭辞は落とす', () => {
    expect(events('<?xml version="1.0"?><x:a b="1"><x:c/>t</x:a>')).toEqual(['<a>', '<c/>', '"t"', '</a>']);
  });

  it('コメント・処理命令・DOCTYPE は読み飛ばし、CDATA は生のまま文字にする', () => {
    expect(events('<!DOCTYPE a [<!ENTITY e "x">]><a><!-- <b/> --><![CDATA[<&>]]></a>')).toEqual([
      '<a>',
      '"<&>"',
      '</a>',
    ]);
  });

  it('属性を局所名で引き、実体参照を戻す。引用符の中の > で閉じない', () => {
    const x = scan(`<c r="A1" x:t='s' v="a &amp; b &lt;c&gt; &#65;&#x42;" w="x>y"/>`);
    expect(x.next()).toBe(XML_START);
    expect(x.attr('r')).toBe('A1');
    expect(x.attr('t')).toBe('s');
    expect(x.attr('v')).toBe('a & b <c> AB');
    expect(x.attr('w')).toBe('x>y');
    expect(x.attr('none')).toBeNull();
    expect(x.selfClosing).toBe(true);
  });

  it('名前空間の宣言 xmlns:r を属性 r と取り違えない', () => {
    const x = scan('<worksheet xmlns:r="urn:x" r="real"/>');
    x.next();
    expect(x.attr('r')).toBe('real');
    const y = scan('<worksheet xmlns:r="urn:x"/>');
    y.next();
    expect(y.attr('r')).toBeNull();
  });

  it('数値・真偽の属性', () => {
    const x = scan('<row r="12" ht="20.25" hidden="1" customHeight="true" bad="x"/>');
    x.next();
    expect(x.attrInt('r', 0)).toBe(12);
    expect(x.attrNumber('ht', NaN)).toBe(20.25);
    expect(x.attrBool('hidden', false)).toBe(true);
    expect(x.attrBool('customHeight', false)).toBe(true);
    expect(x.attrInt('bad', -1)).toBe(-1);
    expect(x.attrNumber('bad', -1)).toBe(-1);
  });

  it('readElementText は直下の文字を連結し、終了タグまで進む', () => {
    const x = scan('<a><t xml:space="preserve"> 東京 &amp; 大阪 </t><u/></a>');
    x.next();
    x.next();
    expect(x.readElementText()).toBe(' 東京 & 大阪 ');
    expect(x.next()).toBe(XML_START);
    expect(x.name()).toBe('u');
  });

  it('BOM を読み飛ばす', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('<a/>')]);
    const x = new XmlScanner(bytes);
    expect(x.next()).toBe(XML_START);
    expect(x.name()).toBe('a');
  });

  it('閉じていないタグ・引用符でも例外を投げずに終わる', () => {
    for (const bad of ['<a b="1', '<a', '<!--', '<![CDATA[x', '<a><b>text', '</', '<a b=1 c>']) {
      expect(() => events(bad)).not.toThrow();
    }
  });
});

describe('実体参照と _xHHHH_', () => {
  it('知らない実体参照は残す', () => {
    expect(unescapeXml('a &nbsp; &amp; &#xZZ; &')).toBe('a &nbsp; & &#xZZ; &');
  });

  it('_x000D_ を CR に戻し、_x005F_ は _ の逃がし', () => {
    expect(unescapeOoxml('a_x000D_b')).toBe('a\rb');
    expect(unescapeOoxml('_x005F_x000D_')).toBe('_x000D_');
    expect(unescapeOoxml('_xZZZZ_')).toBe('_xZZZZ_');
  });
});
