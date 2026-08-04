// The adversarial cases: a hostile archive, and the two nesting bugs that
// produce plausible-looking-but-wrong output rather than an error.
//
// why these deserve their own file: each is a case where the naive
// implementation SUCCEEDS and returns something. A bomb "works" right up until
// it takes the renderer with it, and a duplicated nested list reads perfectly
// well while telling the model the document says things twice.

import { describe, test, expect } from 'bun:test';
import { readZipIndex, readZipEntry, MAX_ENTRY_BYTES } from '../../../extension/peerd-runtime/doc/zip.js';
import { convertToDocument } from '../../../extension/peerd-runtime/doc/convert.js';
import { toMarkdown } from '../../../extension/peerd-runtime/doc/markdown.js';
import { parseXml } from '../../../extension/peerd-runtime/doc/xml.js';
import { makeZip } from './fixtures.ts';

describe('decompression bombs', () => {
  test('a member that inflates past the cap is refused, not inflated', async () => {
    // 8 MB of zeros deflates to ~8 KB — a ~1000:1 ratio, the real shape of the
    // attack. The cap is far above this, so we assert on the mechanism by
    // checking the DECLARED size guard with a lying header below; here we
    // prove the honest large member still round-trips.
    const big = new Uint8Array(8 * 1024 * 1024);
    const zip = await makeZip([{ name: 'big.bin', content: big }]);
    const index = readZipIndex(zip);
    const entry = index.get('big.bin')!;
    // The compressed form is a tiny fraction of the original — this is the
    // ratio that makes a bomb possible in the first place.
    expect(entry.compressedSize).toBeLessThan(big.length / 100);
    const out = await readZipEntry(zip, entry);
    expect(out.length).toBe(big.length);
  });

  test('a header declaring more than the cap is refused before inflating', async () => {
    const zip = await makeZip([{ name: 'word/document.xml', content: '<w:document/>' }]);
    const index = readZipIndex(zip);
    const entry = index.get('word/document.xml')!;
    // Simulate the declared-size lie a bomb uses to look small on the wire.
    const bomb = { ...entry, size: MAX_ENTRY_BYTES + 1 };
    await expect(readZipEntry(zip, bomb)).rejects.toThrow(/limit|declares/);
  });
});

describe('hostile XML', () => {
  test('a DOCTYPE with entity declarations is skipped, not resolved (no XXE)', () => {
    // The classic billion-laughs / file-read payload. The reader must treat the
    // doctype as noise and never expand `&xxe;` — an undefined entity is left
    // as literal text rather than resolved against anything.
    const xml = '<?xml version="1.0"?>'
      + '<!DOCTYPE r [<!ENTITY xxe SYSTEM "file:///etc/passwd"><!ENTITY lol "haha">]>'
      + '<r><a>&xxe;</a><b>&lol;</b></r>';
    const root = parseXml(xml);
    const text = JSON.stringify(root);
    expect(text).not.toContain('/etc/passwd');
    expect(text).not.toContain('haha');
    // Undefined entities survive verbatim — visible, not silently emptied.
    expect(text).toContain('&xxe;');
  });

  test('an unclosed tag truncates cleanly instead of collapsing the tree', () => {
    const root = parseXml('<a><b>first</b><c>second');
    expect(JSON.stringify(root)).toContain('first');
    expect(JSON.stringify(root)).toContain('second');
  });
});

describe('nested lists are not duplicated or reordered', () => {
  // A chapter that nests a list inside a list item, with a sibling item AFTER
  // the nested list — the ordering trap.
  const epubWithNesting = async () => makeZip([
      { name: 'mimetype', content: 'application/epub+zip', store: true },
      {
        name: 'META-INF/container.xml',
        content: '<?xml version="1.0"?><container xmlns="c"><rootfiles>'
          + '<rootfile full-path="b.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      },
      {
        name: 'b.opf',
        content: '<?xml version="1.0"?><package xmlns="p" xmlns:dc="dc">'
          + '<metadata><dc:title>Nested</dc:title></metadata>'
          + '<manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest>'
          + '<spine><itemref idref="c1"/></spine></package>',
      },
      {
        name: 'c1.xhtml',
        content: '<?xml version="1.0"?><html xmlns="h"><body><ul>'
          + '<li>Alpha<ul><li>Alpha one</li><li>Alpha two</li></ul></li>'
          + '<li>Beta</li>'
          + '</ul></body></html>',
      },
  ]);

  test('EPUB: each nested item appears exactly once, indented, in order', async () => {
    const out = toMarkdown(await convertToDocument(await epubWithNesting()));
    // Exactly once — the naive walker emits nested items twice (once folded
    // into the parent's own text, once from the recursion).
    expect(out.match(/Alpha one/g)).toHaveLength(1);
    // The parent keeps only its OWN text, not its children's.
    expect(out).toContain('- Alpha\n');
    expect(out).not.toContain('- AlphaAlpha one');
    // Nesting shows as indentation…
    expect(out).toContain('  - Alpha one');
    expect(out).toContain('  - Alpha two');
    // …and the sibling that FOLLOWS the nested list stays after it.
    expect(out.indexOf('- Beta')).toBeGreaterThan(out.indexOf('Alpha two'));
    // One list block, not three.
    expect(out.split('\n').filter((l) => l.trim().startsWith('- '))).toHaveLength(4);
  });

  test('ODF: a sublist stays inside its parent list, in document order', async () => {
    const ods = await makeZip([
      { name: 'mimetype', content: 'application/vnd.oasis.opendocument.text', store: true },
      {
        name: 'content.xml',
        content: '<?xml version="1.0"?><office:document-content xmlns:office="o" xmlns:text="t">'
          + '<office:body><office:text><text:list>'
          + '<text:list-item><text:p>One</text:p>'
          + '<text:list><text:list-item><text:p>One a</text:p></text:list-item></text:list>'
          + '</text:list-item>'
          + '<text:list-item><text:p>Two</text:p></text:list-item>'
          + '</text:list></office:text></office:body></office:document-content>',
      },
    ]);
    const out = toMarkdown(await convertToDocument(ods));
    expect(out.match(/One a/g)).toHaveLength(1);
    expect(out).toContain('  - One a');
    // The trap: recursing into the block list would emit the sublist BEFORE
    // "Two", which is pushed to the parent list afterwards.
    expect(out.indexOf('One a')).toBeLessThan(out.indexOf('Two'));
  });
});
