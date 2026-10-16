/**
 * The Ret bot glyph's shapes, for the desktop's (components/ui/RetBot) and the phone's
 * (apps/mobile/src/ui/RetBot): drawn on a 36×32 grid (y from -4) and given in pixels at `height`,
 * so no SVG has a view box to scale (each scaled one is a transform node of its own in the
 * browser's paint, like lucide's icons; see Chevron).
 */
export function botShape(height: number) {
  const k = height / 32;
  const n = (v: number) => Math.round(v * k * 1000) / 1000;
  const x = n;
  const y = (v: number) => n(v + 4);
  /** A rounded bar between two arc centres. */
  const bar = (left: number, right: number, top: number, bottom: number) => {
    const r = n((bottom - top) / 2);
    return `M${x(left)} ${y(top)}H${x(right)}A${r} ${r} 0 0 1 ${x(right)} ${y(bottom)}H${x(left)}A${r} ${r} 0 0 1 ${x(left)} ${y(top)}Z`;
  };
  const disc = (cx: number, cy: number, r: number) => `M${x(cx - r)} ${y(cy)}a${n(r)} ${n(r)} 0 1 0 ${n(2 * r)} 0a${n(r)} ${n(r)} 0 1 0 ${-n(2 * r)} 0Z`;
  const point = (px: number, py: number) => ({ x: x(px), y: y(py) });
  return {
    /** One grid unit in pixels, for motion. */
    unit: k,
    width: n(36),
    height,
    box: `0 0 ${n(36)} ${height}`,
    /** The head's shell and the visor in it, with holes for the eyes (even-odd). */
    head: bar(11.5, 20.5, 8, 27) + bar(11.5, 20.5, 10.3, 24.7) + bar(11.5, 20.5, 12.2, 22.8) + disc(12, 17.5, 3.4) + disc(20, 17.5, 3.4),
    stalks: [`M${x(12.5)} ${y(9)}Q${x(10.5)} ${y(5.5)} ${x(8.2)} ${y(3.4)}`, `M${x(19.5)} ${y(9)}Q${x(21.5)} ${y(5.5)} ${x(23.8)} ${y(3.4)}`],
    tips: [point(7.5, 2.9), point(24.5, 2.9)],
    tipR: n(2.6),
    ledR: n(1.1),
    eyes: [point(12, 17.5), point(20, 17.5)],
    pupilR: n(2),
    lidR: n(3.5),
    puff: point(29, 7),
    puffR: [n(0.9), n(1.3), n(1.7)],
    z: `M${x(28)} ${y(4)}h${n(2.6)}l${-n(2.6)} ${n(2.6)}h${n(2.6)}`,
    stroke: { stalk: n(1.9), puff: n(0.9), z: n(1.1) },
    /** Where parts turn and grow from: each antenna where it meets the head, the lids from the eyes' tops, the body from its bottom. */
    pivots: { antL: point(12.5, 9), antR: point(19.5, 9), lids: point(16, 14.1), body: point(16, 27), puff: point(29, 7), z: point(29.3, 5.3) },
  };
}
