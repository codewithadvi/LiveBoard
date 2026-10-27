import type { Point } from "@liveboard/shared";

export interface BezierSegment {
  c1: Point;
  c2: Point;
  end: Point;
}

// Catmull-Rom spline through `pts`, expressed as cubic Béziers (what both the
// canvas and SVG can draw). For the segment p1 -> p2 the control points are
//   c1 = p1 + (p2 - p0) / 6      c2 = p2 - (p3 - p1) / 6
// so the curve leaves and arrives along the direction of its neighbours.
// The first and last points reuse themselves as their missing neighbour.
export function catmullRomSegments(pts: Point[]): BezierSegment[] {
  const out: BezierSegment[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(i - 1, 0)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(i + 2, pts.length - 1)];
    out.push({
      c1: [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6],
      c2: [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6],
      end: p2,
    });
  }
  return out;
}
