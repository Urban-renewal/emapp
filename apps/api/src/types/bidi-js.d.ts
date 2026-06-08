/**
 * Local type declaration for `bidi-js` (no bundled types, no @types package).
 * Surfaces only the subset of the Unicode Bidi Algorithm API we use for
 * logical→visual reordering in the pdf-lib certificate renderer. Mirrors the
 * package README (v1.0.3).
 */
declare module 'bidi-js' {
  /** Inclusive `[start, end]` index range whose characters must be reversed. */
  type ReorderSegment = [start: number, end: number];

  interface Paragraph {
    start: number;
    end: number;
    level: number;
  }

  interface EmbeddingLevels {
    /** Per-character bidi embedding level; odd = RTL scope, even = LTR. */
    levels: Uint8Array;
    paragraphs: Paragraph[];
  }

  interface Bidi {
    getEmbeddingLevels(text: string, explicitDirection?: 'ltr' | 'rtl'): EmbeddingLevels;
    getReorderSegments(
      text: string,
      embeddingLevels: EmbeddingLevels,
      start?: number,
      end?: number,
    ): ReorderSegment[];
    getMirroredCharactersMap(
      text: string,
      embeddingLevels: EmbeddingLevels,
      start?: number,
      end?: number,
    ): Map<number, string>;
    getMirroredCharacter(char: string): string | null;
    getBidiCharTypeName(char: string): string;
  }

  /** The package's only export: a factory returning the stateless `bidi` object. */
  export default function bidiFactory(): Bidi;
}
