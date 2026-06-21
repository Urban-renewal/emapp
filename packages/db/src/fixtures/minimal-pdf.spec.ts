import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { FakeStorageProvider } from '../providers/storage/fake.provider';

import { MINIMAL_PDF, buildMinimalPdf } from './minimal-pdf';

/** Read a Readable fully into a Buffer (for the storage round-trip). */
async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
}

/**
 * Structural validity check — proves the fixture is a real, parseable
 * one-page PDF, not just a `%PDF` header. Verifies the xref table offsets
 * actually point at each `N 0 obj` marker (the failure mode that makes a
 * "PDF" un-renderable), the trailer references the catalog, and the content
 * stream's declared /Length matches its real byte count.
 *
 * (A full pdf.js render was run out-of-band during development and confirms
 * the buffer opens as a 595x842 one-page document; we keep the in-repo
 * assertion dependency-free by checking structure rather than pulling a PDF
 * engine into @emapp/db's test graph.)
 */
function structuralErrors(buf: Buffer): string[] {
  const s = buf.toString('latin1');
  const errs: string[] = [];
  if (!s.startsWith('%PDF-')) errs.push('missing %PDF header');
  if (!s.trimEnd().endsWith('%%EOF')) errs.push('missing %%EOF');

  const sx = s.match(/startxref\s+(\d+)\s+%%EOF/);
  if (!sx) {
    errs.push('missing startxref');
    return errs;
  }
  const xrefOff = Number(sx[1]);
  if (s.slice(xrefOff, xrefOff + 4) !== 'xref') {
    errs.push(`startxref ${xrefOff} does not point at "xref"`);
  }

  const xrefBlock = s.slice(xrefOff);
  const header = xrefBlock.match(/xref\n0 (\d+)\n/);
  if (!header) {
    errs.push('malformed xref header');
    return errs;
  }
  const count = Number(header[1]);
  const entries = [...xrefBlock.matchAll(/(\d{10}) (\d{5}) (n|f) /g)];
  if (entries.length !== count) errs.push(`xref count ${count} != ${entries.length} entries`);
  entries.forEach((e, idx) => {
    if (e[3] === 'n') {
      const off = Number(e[1]);
      const want = `${idx} 0 obj`;
      const at = s.slice(off, off + want.length);
      if (at !== want) errs.push(`obj ${idx}: xref offset ${off} -> "${at}" (want "${want}")`);
    }
  });

  if (!/trailer\s+<<[^>]*\/Root 1 0 R/.test(s)) errs.push('trailer missing /Root 1 0 R');

  const stream = s.match(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/);
  if (!stream) errs.push('missing content stream');
  else {
    const declared = Number(stream[1]);
    const actual = Buffer.byteLength(stream[2]!, 'latin1');
    if (declared !== actual) errs.push(`stream /Length ${declared} != actual ${actual}`);
  }
  return errs;
}

describe('MINIMAL_PDF dev fixture', () => {
  it('starts with the %PDF magic header', () => {
    expect(MINIMAL_PDF.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('is a structurally-valid, parseable one-page PDF (not just a header)', () => {
    expect(structuralErrors(MINIMAL_PDF)).toEqual([]);
    // big enough to carry catalog/pages/page/stream/font + xref + trailer
    expect(MINIMAL_PDF.byteLength).toBeGreaterThan(300);
    expect(MINIMAL_PDF.toString('latin1').trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('buildMinimalPdf renders an arbitrary caption and stays structurally valid', () => {
    const withName = buildMinimalPdf('הסכם דייר — דירה 5.pdf');
    expect(withName.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(structuralErrors(withName)).toEqual([]);
  });

  it('FakeStorageProvider.getObjectStream returns the exact PDF after putObject', async () => {
    const fake = new FakeStorageProvider();
    const key = 'documents/org-test/dev-doc.pdf';
    await fake.putObject(key, MINIMAL_PDF, { contentType: 'application/pdf' });
    const got = await drain(await fake.getObjectStream(key));
    expect(got.equals(MINIMAL_PDF)).toBe(true);
    expect(got.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
