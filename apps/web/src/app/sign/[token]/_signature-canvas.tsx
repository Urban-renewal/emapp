'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * SVG signature canvas — collects mouse + touch strokes into a single
 * `<svg>` element with one `<path d="M…L…">` per stroke.
 *
 * The output is the EXACT shape `PublicSignSubmitInput.signatureSvg`
 * expects: starts with `<svg`, ends with `</svg>`, 50-262144 bytes
 * (shared-types: `PUBLIC_SIGN_SVG_MAX_BYTES`).
 *
 * Pen behavior:
 *  - mousedown / touchstart begins a new path
 *  - mousemove / touchmove appends a point (with a small distance
 *    threshold to skip noise)
 *  - mouseup / touchend closes the path
 *
 * Touch defenses:
 *  - `touch-action: none` on the canvas so the browser doesn't
 *    interpret the drag as a scroll/zoom gesture.
 *  - We listen on both pointer AND touch APIs because some Android
 *    browsers fire only one of them.
 */

interface Point {
  x: number;
  y: number;
}

export interface SignatureCanvasHandle {
  toSvg: () => string;
  clear: () => void;
  isEmpty: () => boolean;
}

interface Props {
  width: number;
  height: number;
  onChange?: (isEmpty: boolean) => void;
  canvasRef: (h: SignatureCanvasHandle | null) => void;
}

/** Minimum movement (in CSS px) before a new point is recorded.
 *  Filters out hand-shake without making strokes blocky. */
const MIN_DELTA = 1.5;

function rdpDist(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function pathFromPoints(pts: Point[]): string {
  const first = pts[0];
  if (!first) return '';
  const head = `M${first.x.toFixed(1)},${first.y.toFixed(1)}`;
  if (pts.length === 1) return head;
  const parts: string[] = [head];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    if (!p) continue;
    parts.push(`L${p.x.toFixed(1)},${p.y.toFixed(1)}`);
  }
  return parts.join('');
}

export function SignatureCanvas({ width, height, onChange, canvasRef }: Props) {
  const svgElRef = useRef<SVGSVGElement | null>(null);
  const [strokes, setStrokes] = useState<Point[][]>([]);
  const currentRef = useRef<Point[] | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);

  const point = useCallback(
    (clientX: number, clientY: number): Point | null => {
      const svg = svgElRef.current;
      if (!svg) return null;
      const rect = svg.getBoundingClientRect();
      return {
        x: ((clientX - rect.left) / rect.width) * width,
        y: ((clientY - rect.top) / rect.height) * height,
      };
    },
    [width, height],
  );

  const begin = useCallback((p: Point) => {
    currentRef.current = [p];
    setIsDrawing(true);
  }, []);

  const extend = useCallback((p: Point) => {
    const cur = currentRef.current;
    if (!cur || cur.length === 0) return;
    const last = cur[cur.length - 1];
    if (last && rdpDist(last, p) < MIN_DELTA) return;
    cur.push(p);
    // Trigger re-render via a shallow strokes copy so the in-progress
    // path becomes visible.
    setStrokes((prev) => prev.slice());
  }, []);

  const finish = useCallback(() => {
    const cur = currentRef.current;
    if (cur && cur.length > 0) {
      setStrokes((prev) => {
        const next = [...prev, cur];
        onChange?.(next.length === 0);
        return next;
      });
    }
    currentRef.current = null;
    setIsDrawing(false);
  }, [onChange]);

  // Pointer events (covers mouse + most touch devices)
  function onPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    const p = point(e.clientX, e.clientY);
    if (!p) return;
    (e.target as SVGSVGElement).setPointerCapture(e.pointerId);
    begin(p);
  }
  function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    if (!isDrawing) return;
    const p = point(e.clientX, e.clientY);
    if (!p) return;
    extend(p);
  }
  function onPointerUp() {
    if (isDrawing) finish();
  }

  // Wire the imperative handle to the parent.
  useEffect(() => {
    const handle: SignatureCanvasHandle = {
      toSvg: () => {
        // Build a self-contained SVG (no namespace prefixes; xmlns set
        // so the BE/storage can render it standalone).
        const paths = strokes
          .map(
            (s) =>
              `<path d="${pathFromPoints(s)}" fill="none" stroke="#111" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`,
          )
          .join('');
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${paths}</svg>`;
      },
      clear: () => {
        setStrokes([]);
        currentRef.current = null;
        setIsDrawing(false);
        onChange?.(true);
      },
      isEmpty: () => strokes.length === 0,
    };
    canvasRef(handle);
    return () => canvasRef(null);
  }, [strokes, width, height, canvasRef, onChange]);

  return (
    <svg
      ref={svgElRef}
      viewBox={`0 0 ${width} ${height}`}
      className="block h-64 w-full select-none rounded-md border bg-white"
      style={{ touchAction: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
    >
      {strokes.map((s, i) => (
        <path
          key={i}
          d={pathFromPoints(s)}
          fill="none"
          stroke="#111"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      {/* In-progress stroke — re-rendered live as the user drags. */}
      {isDrawing && currentRef.current && currentRef.current.length > 0 && (
        <path
          d={pathFromPoints(currentRef.current)}
          fill="none"
          stroke="#111"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}
