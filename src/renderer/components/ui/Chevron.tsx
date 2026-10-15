/**
 * Lucide's chevron-right, drawn the same, but in its own pixels: its view box is its size (the path
 * scaled to fit) and it doesn't clip. Lucide's icons map a 24-unit box onto their size, which gives
 * each one a transform (and a clip) of its own in the browser's paint, and a transcript shows one per
 * folded step: on a canvas full of them, every repaint and re-layering pays for each.
 */
export function Chevron({ size, className }: { size: number; className?: string }) {
  const k = size / 24;
  const n = (v: number) => Math.round(v * k * 1000) / 1000;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      overflow="visible"
      fill="none"
      stroke="currentColor"
      strokeWidth={n(2)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={`m${n(9)} ${n(18)} ${n(6)}-${n(6)}-${n(6)}-${n(6)}`} />
    </svg>
  );
}
