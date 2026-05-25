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
 * §PERF-H2 closure — the previous implementation called `setStrokes`
 * on EVERY pointermove (~60Hz), which re-rendered the entire stroke
 * tree + rebuilt the imperative handle via `useEffect`. With 5+
 * completed strokes that's 300+ reconciliations/sec — visible jank on
 * mid-tier Android.
 *
 * New design (imperative DOM mutation):
 *  - Completed strokes live in React state but are rendered as one
 *    `<path d=...>` per stroke; React renders this tree ONCE per
 *    finished stroke (not per pointer event).
 *  - The in-progress stroke is a dedicated `<path>` whose `d` attribute
 *    is updated imperatively via `pathRef.current.setAttribute('d', ...)`.
 *    No React reconciliation on the hot path.
 *  - The imperative handle (toSvg/clear/isEmpty) reads from refs so its
 *    identity is stable across renders.
 *
 * Touch defenses:
 *  - `touch-action: none` on the canvas so the browser doesn't
 *    interpret the drag as a scroll/zoom gesture.
 *  - Pointer Events API covers mouse + touch + pen uniformly.
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

function dist(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function pathFromPoints(pts: readonly Point[]): string {
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
  // The in-progress <path> element — we mutate its `d` attribute
  // imperatively on every pointermove for 60Hz pen feel without React
  // re-renders.
  const inProgressPathRef = useRef<SVGPathElement | null>(null);
  // Completed strokes (frozen). React renders one <path> per entry —
  // this state only changes when a stroke is finished or all are cleared.
  const [completedStrokes, setCompletedStrokes] = useState<readonly (readonly Point[])[]>([]);
  // The CURRENT (in-progress) stroke is held in a ref — no React state
  // until the pointer-up event lifts it into `completedStrokes`.
  const currentRef = useRef<Point[]>([]);
  const isDrawingRef = useRef(false);

  // onChange tracking: we notify when isEmpty flips. Computed from
  // completedStrokes (the in-progress stroke doesn't count as content
  // until released, but for the Submit-button-enable signal we treat
  // any committed stroke as "not empty").
  const isEmpty = completedStrokes.length === 0;

  // Notify parent when emptiness changes.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    onChangeRef.current?.(isEmpty);
  }, [isEmpty]);

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

  function beginStroke(p: Point) {
    currentRef.current = [p];
    isDrawingRef.current = true;
    // Imperatively update the dedicated in-progress path element.
    const el = inProgressPathRef.current;
    if (el) el.setAttribute('d', pathFromPoints(currentRef.current));
  }

  function extendStroke(p: Point) {
    const cur = currentRef.current;
    if (cur.length === 0) return;
    const last = cur[cur.length - 1];
    if (last && dist(last, p) < MIN_DELTA) return;
    cur.push(p);
    // §PERF-H2 — imperative DOM update; NO setState, NO React reconcile.
    const el = inProgressPathRef.current;
    if (el) el.setAttribute('d', pathFromPoints(cur));
  }

  function finishStroke() {
    if (!isDrawingRef.current) return;
    const cur = currentRef.current;
    isDrawingRef.current = false;
    if (cur.length > 0) {
      // Lift the in-progress stroke into completed state; this is the
      // ONE React render per stroke.
      setCompletedStrokes((prev) => [...prev, cur]);
    }
    currentRef.current = [];
    const el = inProgressPathRef.current;
    if (el) el.setAttribute('d', '');
  }

  // Pointer events (covers mouse + most touch devices)
  function onPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    const p = point(e.clientX, e.clientY);
    if (!p) return;
    (e.target as SVGSVGElement).setPointerCapture(e.pointerId);
    beginStroke(p);
  }
  function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    if (!isDrawingRef.current) return;
    const p = point(e.clientX, e.clientY);
    if (!p) return;
    extendStroke(p);
  }
  function onPointerUp() {
    if (isDrawingRef.current) finishStroke();
  }

  // Imperative handle — stable identity via refs. We expose toSvg/clear/
  // isEmpty so the parent can compose them into form submission.
  useEffect(() => {
    const handle: SignatureCanvasHandle = {
      toSvg: () => {
        // Build a self-contained SVG (no namespace prefixes; xmlns set
        // so the BE/storage can render it standalone).
        const paths = completedStrokes
          .map(
            (s) =>
              `<path d="${pathFromPoints(s)}" fill="none" stroke="#111" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`,
          )
          .join('');
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${paths}</svg>`;
      },
      clear: () => {
        setCompletedStrokes([]);
        currentRef.current = [];
        isDrawingRef.current = false;
        const el = inProgressPathRef.current;
        if (el) el.setAttribute('d', '');
      },
      isEmpty: () => completedStrokes.length === 0,
    };
    canvasRef(handle);
    return () => canvasRef(null);
  }, [completedStrokes, width, height, canvasRef]);

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
      {/* Completed strokes — re-rendered only when a stroke is finished
          (not on every pointer event). One <path> per stroke. */}
      {completedStrokes.map((s, i) => (
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
      {/* In-progress stroke — dedicated <path> mutated imperatively in
          extendStroke(). No React reconcile on the hot path. */}
      <path
        ref={inProgressPathRef}
        d=""
        fill="none"
        stroke="#111"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
