// Build real office files in memory, so the doc tests exercise the WHOLE path
// — ZIP central directory, DEFLATE, XML, the walkers — rather than handing the
// parsers pre-chewed structures. A parser that only ever sees a hand-built tree
// is not tested against the thing it actually meets.
//
// The writer emits both STORE and DEFLATE members, because those are the two
// methods the reader supports and office writers mix them freely (ODF/EPUB
// require the mimetype member to be stored, everything else is deflated).

const encoder = new TextEncoder();

// CRC-32, needed because a ZIP reader is entitled to reject a bad checksum and
// a fixture that only works against our own reader would prove nothing.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const deflateRaw = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

export type ZipMember = { name: string; content: string | Uint8Array; store?: boolean };

/** Write a ZIP archive: local headers, then the central directory, then EOCD. */
export const makeZip = async (members: ZipMember[]): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const member of members) {
    const raw = typeof member.content === 'string' ? encoder.encode(member.content) : member.content;
    const stored = member.store === true;
    const body = stored ? raw : await deflateRaw(raw);
    const name = encoder.encode(member.name);
    const crc = crc32(raw);

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, stored ? 0 : 8, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    chunks.push(local, body);

    const dir = new Uint8Array(46 + name.length);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(10, stored ? 0 : 8, true);
    dv.setUint32(16, crc, true);
    dv.setUint32(20, body.length, true);
    dv.setUint32(24, raw.length, true);
    dv.setUint16(28, name.length, true);
    dv.setUint32(42, offset, true);
    dir.set(name, 46);
    central.push(dir);

    offset += local.length + body.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, members.length, true);
  ev.setUint16(10, members.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const all = [...chunks, ...central, eocd];
  const total = all.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const chunk of all) { out.set(chunk, p); p += chunk.length; }
  return out;
};

const CONTENT_TYPES = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';

/** A .docx with headings, styled runs, a hyperlink, a numbered list and a table. */
export const makeDocx = async (): Promise<Uint8Array> => makeZip([
  { name: '[Content_Types].xml', content: CONTENT_TYPES },
  {
    name: 'docProps/core.xml',
    content: '<?xml version="1.0"?><cp:coreProperties xmlns:cp="x" xmlns:dc="y">'
      + '<dc:title>Quarterly Report</dc:title><dc:creator>A. Writer</dc:creator></cp:coreProperties>',
  },
  {
    name: 'word/_rels/document.xml.rels',
    content: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId4" Target="https://example.com/spec"/></Relationships>',
  },
  {
    name: 'word/numbering.xml',
    content: '<?xml version="1.0"?><w:numbering xmlns:w="w">'
      + '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>'
      + '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>'
      + '<w:num w:numId="7"><w:abstractNumId w:val="0"/></w:num>'
      + '<w:num w:numId="8"><w:abstractNumId w:val="1"/></w:num>'
      + '</w:numbering>',
  },
  {
    name: 'word/document.xml',
    content: '<?xml version="1.0"?><w:document xmlns:w="w" xmlns:r="r"><w:body>'
      + '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Findings</w:t></w:r></w:p>'
      // Two runs of the same styling: they must merge into one **bold** span.
      + '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Revenue </w:t></w:r>'
      + '<w:r><w:rPr><w:b/></w:rPr><w:t>rose</w:t></w:r>'
      + '<w:r><w:t xml:space="preserve"> by 4%. See </w:t></w:r>'
      + '<w:hyperlink r:id="rId4"><w:r><w:t>the spec</w:t></w:r></w:hyperlink>'
      + '<w:r><w:t>.</w:t></w:r></w:p>'
      // b val="0" is bold OFF — a common trap.
      + '<w:p><w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t>Not bold.</w:t></w:r></w:p>'
      + '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr></w:pPr><w:r><w:t>First step</w:t></w:r></w:p>'
      + '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr></w:pPr><w:r><w:t>Second step</w:t></w:r></w:p>'
      + '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="8"/></w:numPr></w:pPr><w:r><w:t>A bullet</w:t></w:r></w:p>'
      // numId 0 means "explicitly not a list" — must NOT become a bullet.
      + '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="0"/></w:numPr></w:pPr><w:r><w:t>Plain again</w:t></w:r></w:p>'
      + '<w:tbl>'
      + '<w:tr><w:tc><w:p><w:r><w:t>Region</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Total</w:t></w:r></w:p></w:tc></w:tr>'
      + '<w:tr><w:tc><w:p><w:r><w:t>EMEA | North</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>12</w:t></w:r></w:p></w:tc></w:tr>'
      + '</w:tbl>'
      + '<w:sectPr/></w:body></w:document>',
  },
]);

/** A .xlsx with a shared-string pool, a sparse row, a formula and a hidden sheet. */
export const makeXlsx = async (): Promise<Uint8Array> => makeZip([
  { name: '[Content_Types].xml', content: CONTENT_TYPES },
  {
    name: 'xl/_rels/workbook.xml.rels',
    content: '<?xml version="1.0"?><Relationships xmlns="r">'
      + '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>'
      + '<Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
  },
  {
    name: 'xl/workbook.xml',
    content: '<?xml version="1.0"?><workbook xmlns="w" xmlns:r="r"><sheets>'
      + '<sheet name="Sales" sheetId="1" r:id="rId1"/>'
      + '<sheet name="Scratch" sheetId="2" state="hidden" r:id="rId2"/>'
      + '</sheets></workbook>',
  },
  {
    name: 'xl/sharedStrings.xml',
    content: '<?xml version="1.0"?><sst xmlns="s">'
      + '<si><t>Region</t></si><si><t>Q1</t></si><si><t>Q2</t></si>'
      + '<si><r><t>EM</t></r><r><t>EA</t></r></si>'
      + '</sst>',
  },
  {
    name: 'xl/worksheets/sheet1.xml',
    content: '<?xml version="1.0"?><worksheet xmlns="w"><sheetData>'
      + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>'
      // B2 is ABSENT — the sparse-cell trap. C2 must stay in column 3.
      + '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="C2"><v>91</v></c></row>'
      + '<row r="3"><c r="A3" t="inlineStr"><is><t>APAC</t></is></c>'
      + '<c r="B3"><f>SUM(1,2)</f><v>3</v></c><c r="C3" t="b"><v>1</v></c></row>'
      + '</sheetData></worksheet>',
  },
  {
    name: 'xl/worksheets/sheet2.xml',
    content: '<?xml version="1.0"?><worksheet xmlns="w"><sheetData>'
      + '<row r="1"><c r="A1" t="inlineStr"><is><t>SECRET</t></is></c></row></sheetData></worksheet>',
  },
]);

/** A .pptx with two ordered slides, a title placeholder and speaker notes. */
export const makePptx = async (): Promise<Uint8Array> => makeZip([
  { name: '[Content_Types].xml', content: CONTENT_TYPES },
  {
    name: 'ppt/_rels/presentation.xml.rels',
    content: '<?xml version="1.0"?><Relationships xmlns="r">'
      + '<Relationship Id="rId2" Target="slides/slide1.xml"/>'
      + '<Relationship Id="rId3" Target="slides/slide2.xml"/></Relationships>',
  },
  {
    name: 'ppt/presentation.xml',
    // Deliberately listed out of rels order: the sldIdLst is the authority.
    content: '<?xml version="1.0"?><p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst>'
      + '<p:sldId id="rId3"/><p:sldId id="rId2"/>'
      + '</p:sldIdLst></p:presentation>',
  },
  {
    name: 'ppt/slides/slide1.xml',
    content: '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>'
      + '<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>'
      + '<p:txBody><a:p><a:r><a:t>Second Deck Slide</a:t></a:r></a:p></p:txBody></p:sp>'
      + '<p:sp><p:txBody><a:p><a:r><a:t>Body text here</a:t></a:r></a:p></p:txBody></p:sp>'
      + '</p:spTree></p:cSld></p:sld>',
  },
  {
    name: 'ppt/slides/_rels/slide1.xml.rels',
    content: '<?xml version="1.0"?><Relationships xmlns="r">'
      + '<Relationship Id="rId1" Target="../notesSlides/notesSlide1.xml"/></Relationships>',
  },
  {
    name: 'ppt/notesSlides/notesSlide1.xml',
    content: '<?xml version="1.0"?><p:notes xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>'
      + '<p:sp><p:txBody><a:p><a:r><a:t>1</a:t></a:r></a:p>'
      + '<a:p><a:r><a:t>Remember to mention margin.</a:t></a:r></a:p></p:txBody></p:sp>'
      + '</p:spTree></p:cSld></p:notes>',
  },
  {
    name: 'ppt/slides/slide2.xml',
    content: '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>'
      + '<p:sp><p:nvSpPr><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr>'
      + '<p:txBody><a:p><a:r><a:t>First Deck Slide</a:t></a:r></a:p></p:txBody></p:sp>'
      + '</p:spTree></p:cSld></p:sld>',
  },
]);

/** An .odt — mimetype STORED first, as the spec requires. */
export const makeOdt = async (): Promise<Uint8Array> => makeZip([
  { name: 'mimetype', content: 'application/vnd.oasis.opendocument.text', store: true },
  {
    name: 'meta.xml',
    content: '<?xml version="1.0"?><office:document-meta xmlns:office="o" xmlns:dc="dc">'
      + '<office:meta><dc:title>Field Notes</dc:title><dc:creator>O. Writer</dc:creator></office:meta>'
      + '</office:document-meta>',
  },
  {
    name: 'content.xml',
    content: '<?xml version="1.0"?><office:document-content xmlns:office="o" xmlns:text="t" xmlns:table="tb" xmlns:xlink="x">'
      + '<office:body><office:text>'
      + '<text:h text:outline-level="1">Observations</text:h>'
      + '<text:p>Plain paragraph with <text:a xlink:href="https://example.org/x">a link</text:a>.</text:p>'
      + '<text:list><text:list-item><text:p>Alpha</text:p></text:list-item>'
      + '<text:list-item><text:p>Beta</text:p></text:list-item></text:list>'
      + '<table:table table:name="T1">'
      + '<table:table-row><table:table-cell><text:p>Key</text:p></table:table-cell>'
      + '<table:table-cell><text:p>Value</text:p></table:table-cell></table:table-row>'
      + '<table:table-row><table:table-cell><text:p>depth</text:p></table:table-cell>'
      + '<table:table-cell><text:p>12m</text:p></table:table-cell></table:table-row>'
      + '</table:table>'
      + '</office:text></office:body></office:document-content>',
  },
]);

/** An .ods exercising the repeated-cell padding LibreOffice emits. */
export const makeOds = async (): Promise<Uint8Array> => makeZip([
  { name: 'mimetype', content: 'application/vnd.oasis.opendocument.spreadsheet', store: true },
  {
    name: 'content.xml',
    content: '<?xml version="1.0"?><office:document-content xmlns:office="o" xmlns:text="t" xmlns:table="tb">'
      + '<office:body><office:spreadsheet>'
      + '<table:table table:name="Data">'
      + '<table:table-row><table:table-cell><text:p>Name</text:p></table:table-cell>'
      + '<table:table-cell><text:p>Count</text:p></table:table-cell>'
      + '<table:table-cell table:number-columns-repeated="16381"/></table:table-row>'
      + '<table:table-row><table:table-cell><text:p>widgets</text:p></table:table-cell>'
      + '<table:table-cell><text:p>7</text:p></table:table-cell>'
      + '<table:table-cell table:number-columns-repeated="16381"/></table:table-row>'
      + '<table:table-row table:number-rows-repeated="1048574"><table:table-cell table:number-columns-repeated="16384"/></table:table-row>'
      + '</table:table>'
      + '</office:spreadsheet></office:body></office:document-content>',
  },
]);

/** An .epub whose spine order differs from its manifest order. */
export const makeEpub = async (): Promise<Uint8Array> => makeZip([
  { name: 'mimetype', content: 'application/epub+zip', store: true },
  {
    name: 'META-INF/container.xml',
    content: '<?xml version="1.0"?><container xmlns="c"><rootfiles>'
      + '<rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/>'
      + '</rootfiles></container>',
  },
  {
    name: 'OEBPS/book.opf',
    content: '<?xml version="1.0"?><package xmlns="p" xmlns:dc="dc">'
      + '<metadata><dc:title>A Short Book</dc:title><dc:creator>E. Author</dc:creator>'
      + '<dc:language>en</dc:language></metadata>'
      + '<manifest>'
      + '<item id="css" href="style.css" media-type="text/css"/>'
      + '<item id="two" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>'
      + '<item id="one" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>'
      + '</manifest>'
      + '<spine><itemref idref="one"/><itemref idref="two"/></spine>'
      + '</package>',
  },
  { name: 'OEBPS/style.css', content: 'body { margin: 0 }' },
  {
    name: 'OEBPS/text/ch1.xhtml',
    content: '<?xml version="1.0"?><html xmlns="h"><body>'
      + '<h1>Chapter One</h1><p>It was a <strong>dark</strong> and stormy night.</p>'
      + '<ul><li>one</li><li>two</li></ul>'
      + '</body></html>',
  },
  {
    name: 'OEBPS/text/ch2.xhtml',
    content: '<?xml version="1.0"?><html xmlns="h"><body>'
      + '<h1>Chapter Two</h1><p>The morning came.</p>'
      + '<blockquote>A quoted line.</blockquote>'
      + '</body></html>',
  },
]);
