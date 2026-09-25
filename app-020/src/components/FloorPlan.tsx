import { memo, type PointerEvent as RPointerEvent, type WheelEvent as RWheelEvent } from 'react';
import type { FacilityKind, Floor, Facility, Pt, Room } from '../model';
import { USAGE_FILLS, FacilityGlyph } from './symbols';

export type Tool = 'select' | 'pan' | 'room' | 'corridor' | FacilityKind;
export type Selection = { type: 'room' | 'facility'; id: string } | null;
export type View = { cx: number; cy: number; zoom: number }; // zoom: px per mm

export type DragState = {
  kind: 'room' | 'facility' | 'mark' | 'pan';
  id?: string;
  startMm: Pt;
  orig: Pt[] | Pt | { cx: number; cy: number };
  moved: boolean;
} | null;

export function mmFromEvent(svg: SVGSVGElement, view: View, e: { clientX: number; clientY: number }): Pt {
  const rect = svg.getBoundingClientRect();
  return {
    x: Math.round(view.cx + (e.clientX - rect.left - rect.width / 2) / view.zoom),
    y: Math.round(view.cy + (e.clientY - rect.top - rect.height / 2) / view.zoom),
  };
}

const DIFF_COLORS = {
  added: { stroke: '#2e7d32', fill: '#e5f3e6', tag: '新增' },
  removed: { stroke: '#c62828', fill: '#fdecea', tag: '删除' },
  changed: { stroke: '#e68a00', fill: '#fff6e0', tag: '改动' },
} as const;

export type DiffMarks = {
  roomStatus: Map<string, keyof typeof DIFF_COLORS>;
  facilityStatus: Map<string, keyof typeof DIFF_COLORS>;
  /** 有差异标注时，未变图元淡化显示 */
  active: boolean;
};

const RoomShape = memo(function RoomShape({
  room,
  selected,
  delta,
  diffStatus,
  dimmed,
  onPointerDown,
}: {
  room: Room;
  selected: boolean;
  delta: Pt;
  diffStatus?: keyof typeof DIFF_COLORS;
  dimmed?: boolean;
  onPointerDown: (e: RPointerEvent<SVGGElement>, room: Room) => void;
}) {
  const pts = room.polygon.map((p) => `${p.x + delta.x},${p.y + delta.y}`).join(' ');
  const cx = room.polygon.reduce((s, p) => s + p.x, 0) / room.polygon.length + delta.x;
  const cy = room.polygon.reduce((s, p) => s + p.y, 0) / room.polygon.length + delta.y;
  const dc = diffStatus ? DIFF_COLORS[diffStatus] : null;
  return (
    <g
      onPointerDown={(e) => {
        e.stopPropagation();
        onPointerDown(e, room);
      }}
      style={{ cursor: 'pointer', opacity: dimmed ? 0.35 : 1 }}
    >
      <polygon
        points={pts}
        fill={dc ? dc.fill : USAGE_FILLS[room.usage]}
        stroke={dc ? dc.stroke : selected ? '#1976d2' : '#333333'}
        strokeWidth={dc ? 5 : room.usage === 'corridor' ? 3 : 2.5}
        strokeDasharray={diffStatus === 'removed' ? '12 6' : undefined}
        vectorEffect="non-scaling-stroke"
      />
      <text
        x={cx}
        y={cy}
        textAnchor="middle"
        fontSize={400}
        fill="#333"
        style={{ userSelect: 'none', pointerEvents: 'none' }}
      >
        {room.name}
        <tspan x={cx} dy={480} fontSize={320} fill="#888">
          {room.areaM2.toFixed(1)}㎡
        </tspan>
      </text>
      {dc && (
        <text
          x={room.polygon[0].x + delta.x + 300}
          y={room.polygon[0].y + delta.y - 250}
          fontSize={380}
          fontWeight="bold"
          fill={dc.stroke}
          style={{ userSelect: 'none', pointerEvents: 'none' }}
        >
          {dc.tag}
        </text>
      )}
    </g>
  );
});

const FacilityShape = memo(function FacilityShape({
  fac,
  selected,
  delta,
  diffStatus,
  dimmed,
  onPointerDown,
}: {
  fac: Facility;
  selected: boolean;
  delta: Pt;
  diffStatus?: keyof typeof DIFF_COLORS;
  dimmed?: boolean;
  onPointerDown: (e: RPointerEvent<SVGGElement>, fac: Facility) => void;
}) {
  const x = fac.x + delta.x;
  const y = fac.y + delta.y;
  const dc = diffStatus ? DIFF_COLORS[diffStatus] : null;
  return (
    <g
      transform={`translate(${x},${y})`}
      onPointerDown={(e) => {
        e.stopPropagation();
        onPointerDown(e, fac);
      }}
      style={{ cursor: 'pointer', opacity: dimmed ? 0.35 : 1 }}
    >
      {dc && <circle r={fac.kind === 'exit' ? 1400 : 1000} fill={dc.fill} stroke={dc.stroke} strokeWidth={4} strokeDasharray={diffStatus === 'removed' ? '10 6' : undefined} vectorEffect="non-scaling-stroke" />}
      {selected && !dc && <circle r={900} fill="none" stroke="#1976d2" strokeWidth={2} vectorEffect="non-scaling-stroke" />}
      <FacilityGlyph kind={fac.kind} s={fac.kind === 'exit' ? 700 : 550} />
      <text y={1150} textAnchor="middle" fontSize={330} fill={dc ? dc.stroke : '#555'} fontWeight={dc ? 'bold' : undefined} style={{ userSelect: 'none', pointerEvents: 'none' }}>
        {fac.code}
        {dc && (
          <tspan x={0} dy={380} fontSize={300}>
            {dc.tag}
          </tspan>
        )}
      </text>
    </g>
  );
});

export type FloorPlanProps = {
  floor: Floor;
  view: View;
  svgRef: React.RefObject<SVGSVGElement | null>;
  underlayUrl: string | null;
  showGrid?: boolean;
  selected: Selection;
  drag: DragState;
  dragDelta: Pt;
  draftPoints: Pt[];
  draftCursor: Pt | null;
  coverageCells: Pt[] | null;
  highlight: Pt | null;
  markPt: Pt | null;
  /** 版本对照模式：图元差异标注（新增/删除/改动），不传则为普通编辑/打印渲染 */
  diffMarks?: DiffMarks | null;
  onRoomPointerDown?: (e: RPointerEvent<SVGGElement>, room: Room) => void;
  onFacilityPointerDown?: (e: RPointerEvent<SVGGElement>, fac: Facility) => void;
  onMarkPointerDown?: (e: RPointerEvent<SVGGElement>) => void;
};

/** 图纸渲染（编辑器 / 打印 / 版本对照共用）：毫米坐标，1 单位 = 1mm */
export function FloorPlan(props: FloorPlanProps) {
  const {
    floor, view, svgRef, underlayUrl, showGrid = true,
    selected, drag, dragDelta, draftPoints, draftCursor,
    coverageCells, highlight, markPt, diffMarks,
    onRoomPointerDown, onFacilityPointerDown, onMarkPointerDown,
  } = props;
  void svgRef;

  return (
    <>
      {underlayUrl && floor.underlay?.visible && (
        <image
          href={underlayUrl}
          x={floor.underlay.offsetX}
          y={floor.underlay.offsetY}
          width={floor.underlay.wPx * floor.underlay.scaleMmPerPx}
          height={floor.underlay.hPx * floor.underlay.scaleMmPerPx}
          opacity={floor.underlay.opacity}
          preserveAspectRatio="none"
        />
      )}
      {showGrid && view.zoom > 0.02 && (
        <g>
          <defs>
            <pattern id="grid1m" width={1000} height={1000} patternUnits="userSpaceOnUse">
              <path d="M 1000 0 L 0 0 0 1000" fill="none" stroke="#e4e4e4" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            </pattern>
            <pattern id="grid5m" width={5000} height={5000} patternUnits="userSpaceOnUse">
              <rect width={5000} height={5000} fill="url(#grid1m)" />
              <path d="M 5000 0 L 0 0 0 5000" fill="none" stroke="#cfcfcf" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            </pattern>
          </defs>
          <rect x={-500000} y={-500000} width={1000000} height={1000000} fill="url(#grid5m)" />
        </g>
      )}
      {floor.rooms.map((r) => (
        <RoomShape
          key={r.id}
          room={r}
          selected={selected?.type === 'room' && selected.id === r.id}
          delta={drag?.kind === 'room' && drag.id === r.id ? dragDelta : { x: 0, y: 0 }}
          diffStatus={diffMarks?.roomStatus.get(r.id)}
          dimmed={diffMarks?.active && !diffMarks.roomStatus.has(r.id)}
          onPointerDown={onRoomPointerDown ?? (() => {})}
        />
      ))}
      {coverageCells && (
        <g fill="#ef5350" opacity={0.45}>
          {coverageCells.map((c, i) => (
            <rect key={i} x={c.x - 250} y={c.y - 250} width={500} height={500} />
          ))}
        </g>
      )}
      {floor.facilities.map((f) => (
        <FacilityShape
          key={f.id}
          fac={f}
          selected={selected?.type === 'facility' && selected.id === f.id}
          delta={drag?.kind === 'facility' && drag.id === f.id ? dragDelta : { x: 0, y: 0 }}
          diffStatus={diffMarks?.facilityStatus.get(f.id)}
          dimmed={diffMarks?.active && !diffMarks.facilityStatus.has(f.id)}
          onPointerDown={onFacilityPointerDown ?? (() => {})}
        />
      ))}
      {draftPoints.length > 0 && (
        <g>
          <polygon
            points={draftPoints.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="#1976d2"
            opacity={0.15}
          />
          <polyline
            points={[...draftPoints, ...(draftCursor ? [draftCursor] : [])].map((p) => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke="#1976d2"
            strokeWidth={2}
            strokeDasharray="8 6"
            vectorEffect="non-scaling-stroke"
          />
          {draftPoints.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r={i === 0 ? 350 : 200} fill="#1976d2" />
          ))}
        </g>
      )}
      {highlight && (
        <g pointerEvents="none">
          <circle cx={highlight.x} cy={highlight.y} r={1200} fill="none" stroke="#e53935" strokeWidth={3} vectorEffect="non-scaling-stroke" />
          <circle cx={highlight.x} cy={highlight.y} r={300} fill="#e53935" />
        </g>
      )}
      {markPt && (
        <g
          transform={`translate(${markPt.x + (drag?.kind === 'mark' ? dragDelta.x : 0)},${markPt.y + (drag?.kind === 'mark' ? dragDelta.y : 0)})`}
          onPointerDown={(e) => onMarkPointerDown?.(e)}
          style={{ cursor: onMarkPointerDown ? 'move' : 'default' }}
        >
          <circle r={700} fill="#e53935" stroke="#fff" strokeWidth={2} vectorEffect="non-scaling-stroke" />
          <text y={-1000} textAnchor="middle" fontSize={420} fill="#c62828" fontWeight="bold" style={{ userSelect: 'none', pointerEvents: 'none' }}>
            您在此
          </text>
        </g>
      )}
    </>
  );
}

export function wheelZoom(view: View, e: RWheelEvent, svg: SVGSVGElement): View {
  const rect = svg.getBoundingClientRect();
  const mmX = view.cx + (e.clientX - rect.left - rect.width / 2) / view.zoom;
  const mmY = view.cy + (e.clientY - rect.top - rect.height / 2) / view.zoom;
  const factor = Math.exp(-e.deltaY * 0.0012);
  const zoom = Math.min(3, Math.max(0.008, view.zoom * factor));
  return {
    zoom,
    cx: mmX - (e.clientX - rect.left - rect.width / 2) / zoom,
    cy: mmY - (e.clientY - rect.top - rect.height / 2) / zoom,
  };
}
