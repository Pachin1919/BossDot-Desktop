import JSZip from 'jszip';
import type { ResumeDocData } from './resumeContact';

const xml = (text: string) => text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
}[char] ?? ''));

export async function buildResumeDocx(data: ResumeDocData): Promise<ArrayBuffer> {
  const zip = new JSZip();
  const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  zip.file('[Content_Types].xml', declaration + `
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.file('_rels/.rels', declaration + `
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);

  const paragraph = (value: string, size = 21, heading = false, indent = 0) => value
    ? `<w:p><w:pPr>${heading ? '<w:keepNext/>' : ''}<w:spacing w:after="100" w:line="276" w:lineRule="auto"/>${indent ? `<w:ind w:left="${indent}"/>` : ''}</w:pPr>
<w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei"/>${heading ? '<w:b/>' : ''}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr><w:t xml:space="preserve">${xml(value)}</w:t></w:r></w:p>`
    : '';
  const { name, phone, email, targetTitle } = data.contact;
  const heading = [paragraph(name, 38, true), paragraph(targetTitle, 24, true), paragraph([phone, email].filter(Boolean).join('  |  '))];
  const sections = data.modules.flatMap((section) => [
    paragraph(section.title, 26, true),
    ...(section.blocks || []).flatMap((block) => [
      paragraph(block.heading, 23, true),
      paragraph(block.meta),
      ...block.bullets.map((bullet) => paragraph(`• ${bullet}`, 21, false, 200)),
    ]),
    ...(section.lines || []).map((line) => paragraph(line)),
  ]);
  zip.file('word/document.xml', declaration + `<w:document xmlns:w="${word}"><w:body>
${[...heading, ...sections].join('')}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="780" w:right="880" w:bottom="780" w:left="880" w:header="360" w:footer="360" w:gutter="0"/></w:sectPr>
</w:body></w:document>`);
  return zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
}
