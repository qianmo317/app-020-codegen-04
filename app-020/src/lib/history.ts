import type {
  Floor,
  FloorMetrics,
  FloorSnapshot,
  PlanChange,
  Room,
  ValidationItem,
  ValidationResult,
} from '../model';
import { MM_PER_M, bboxOf, pointInPoly, polyAreaM2 } from './geometry';

// ---------- 平面指标 ----------

/**
 * 走道长度：所有走道多边形合并网络的「最远点对路径长度」（栅格图直径，单位 m）。
 * 栅格 0.25m、8 邻接（对角 √2），多边形顶点挂接到最近可行走栅格，
 * 两次 Dijkstra 求直径；宽度方向的斜步会带来约半格的系统高估，
 * 而版本对照看的是两版之差，该偏差在两版间基本相消。无走道多边形时返回 null。
 */
export function corridorLengthM(snapshot: Pick<FloorSnapshot, 'rooms'>): number | null {
  const corridors = snapshot.rooms.filter((r) => r.usage === 'corridor');
  if (!corridors.length) return null;
  const polys = corridors.map((r) => r.polygon);
  const bb = bboxOf(polys);
  const maxSpan = Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY);
  // 超大平面放宽栅格，控制节点量（对照指标，0.5m 精度足够）
  const step = maxSpan > 200000 ? 500 : 250;
  const ox = Math.floor(bb.minX / step) * step;
  const oy = Math.floor(bb.minY / step) * step;
  const nx = Math.ceil((bb.maxX - ox) / step) + 1;
  const ny = Math.ceil((bb.maxY - oy) / step) + 1;
  if (nx * ny > 4_000_000) return null;

  const inside = new Uint8Array(nx * ny);
  for (const poly of polys) {
    const pbb = bboxOf([poly]);
    const i0 = Math.max(0, Math.floor((pbb.minX - ox) / step));
    const i1 = Math.min(nx - 1, Math.ceil((pbb.maxX - ox) / step));
    const j0 = Math.max(0, Math.floor((pbb.minY - oy) / step));
    const j1 = Math.min(ny - 1, Math.ceil((pbb.maxY - oy) / step));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (pointInPoly({ x: ox + i * step, y: oy + j * step }, poly)) inside[j * nx + i] = 1;
      }
    }
  }
  // 与 graph.ts 相同的 1 格（4 邻）膨胀，补上共边多边形边界处的断缝
  const mask = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      if (inside[c]) {
        mask[c] = 1;
        continue;
      }
      if (
        (i > 0 && inside[c - 1]) || (i < nx - 1 && inside[c + 1]) ||
        (j > 0 && inside[c - nx]) || (j < ny - 1 && inside[c + nx])
      ) mask[c] = 1;
    }
  }

  const idxC = new Int32Array(nx * ny).fill(-1);
  const cells: number[] = [];
  for (let c = 0; c < nx * ny; c++) {
    if (mask[c]) { idxC[c] = cells.length; cells.push(c); }
  }
  const n = cells.length;
  if (!n) return 0;
  const walkAt = (i: number, j: number) => i >= 0 && i < nx && j >= 0 && j < ny && mask[j * nx + i] === 1;
  const SQRT2 = Math.SQRT2;

  /** 从节点 s 出发到所有栅格节点的最短距离（8 邻接，对角需两正交邻居均可行） */
  const dijkstra = (s: number): Float64Array => {
    const d = new Float64Array(n).fill(Infinity);
    d[s] = 0;
    const hu: number[] = [s];
    const hd: number[] = [0];
    const swap = (a: number, b: number) => {
      [hu[a], hu[b]] = [hu[b], hu[a]];
      [hd[a], hd[b]] = [hd[b], hd[a]];
    };
    while (hu.length) {
      const u = hu[0];
      const du = hd[0];
      const lu = hu.pop()!;
      hd.pop();
      if (hu.length) {
        hu[0] = lu;
        hd[0] = d[lu];
        let i = 0;
        for (;;) {
          const l = i * 2 + 1;
          const r = l + 1;
          let m = i;
          if (l < hu.length && hd[l] < hd[m]) m = l;
          if (r < hu.length && hd[r] < hd[m]) m = r;
          if (m === i) break;
          swap(m, i);
          i = m;
        }
      }
      if (du > d[u]) continue;
      const c = cells[u];
      const i = c % nx;
      const j = (c - i) / nx;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (di === 0 && dj === 0) continue;
          if (!walkAt(i + di, j + dj)) continue;
          // 对角：两个正交邻居都可行才连，防止切角穿墙
          if (di !== 0 && dj !== 0 && !(walkAt(i + di, j) && walkAt(i, j + dj))) continue;
          const v = idxC[(j + dj) * nx + (i + di)];
          const nd = du + (di !== 0 && dj !== 0 ? SQRT2 : 1) * step;
          if (nd < d[v]) {
            d[v] = nd;
            hu.push(v);
            hd.push(nd);
            let k = hu.length - 1;
            while (k > 0) {
              const p = (k - 1) >> 1;
              if (hd[p] <= hd[k]) break;
              swap(p, k);
              k = p;
            }
          }
        }
      }
    }
    return d;
  };

  const d0 = dijkstra(0);
  let far = 0;
  let farD = -1;
  for (let u = 0; u < n; u++) {
    if (d0[u] > farD) { farD = d0[u]; far = u; }
  }
  if (!isFinite(farD)) return null;
  const d1 = dijkstra(far);
  let diam = 0;
  for (const v of d1) if (isFinite(v) && v > diam) diam = v;
  return diam / MM_PER_M;
}

export function floorMetrics(snapshot: FloorSnapshot): FloorMetrics {
  const areaM2 = snapshot.rooms.reduce((s, r) => s + polyAreaM2(r.polygon), 0);
  return {
    areaM2,
    roomCount: snapshot.rooms.length,
    exitCount: snapshot.facilities.filter((f) => f.kind === 'exit').length,
    corridorLengthM: corridorLengthM(snapshot),
  };
}

// ---------- 图元改动比对 ----------

export const PLAN_CHANGE_LABELS: Record<PlanChange['kind'], string> = {
  room_added: '新增房间',
  room_removed: '删除房间',
  room_moved: '平移房间',
  room_reshaped: '挪动墙体',
  room_renamed: '房间改名',
  room_reusage: '更改用途',
  room_occupants: '调整人数',
  facility_added: '新增设施',
  facility_removed: '删除设施',
  facility_moved: '移动设施',
  exit_added: '新增安全出口',
  exit_removed: '拆除安全出口',
};

const MOVE_TOL_MM = 50; // 0.05m 内视为未动（吸附网格 0.1m，比较用的是结构化快照）
const SHAPE_TOL_MM = 50;

export type PlanDiff = {
  changes: PlanChange[];
  addedRooms: Set<string>;
  removedRooms: Set<string>;
  changedRooms: Set<string>;
  addedFacilities: Set<string>;
  removedFacilities: Set<string>;
  changedFacilities: Set<string>;
};

/** 两多边形顶点数相同且后者 = 前者整体平移时返回位移，否则返回 false */
function sameShapeTranslated(p1: Room['polygon'], p2: Room['polygon']): { dx: number; dy: number } | false {
  if (p1.length !== p2.length || !p1.length) return false;
  const dx = p2[0].x - p1[0].x;
  const dy = p2[0].y - p1[0].y;
  for (let i = 1; i < p1.length; i++) {
    if (Math.abs(p2[i].x - p1[i].x - dx) > SHAPE_TOL_MM || Math.abs(p2[i].y - p1[i].y - dy) > SHAPE_TOL_MM) {
      return false;
    }
  }
  return { dx, dy };
}

export function diffPlans(a: FloorSnapshot, b: FloorSnapshot): PlanDiff {
  const result: PlanDiff = {
    changes: [],
    addedRooms: new Set(),
    removedRooms: new Set(),
    changedRooms: new Set(),
    addedFacilities: new Set(),
    removedFacilities: new Set(),
    changedFacilities: new Set(),
  };
  const push = (c: PlanChange) => result.changes.push(c);

  // ---- 房间（按 id 配对；几何变化优先于属性变化）----
  const ra = new Map(a.rooms.map((r) => [r.id, r]));
  const rb = new Map(b.rooms.map((r) => [r.id, r]));
  for (const r of b.rooms) {
    const old = ra.get(r.id);
    if (!old) {
      result.addedRooms.add(r.id);
      push({ kind: 'room_added', entityId: r.id, name: r.name });
      continue;
    }
    if (old.polygon.length !== r.polygon.length) {
      result.changedRooms.add(r.id);
      push({ kind: 'room_reshaped', entityId: r.id, name: r.name });
      continue;
    }
    const trans = sameShapeTranslated(old.polygon, r.polygon);
    if (trans === false) {
      result.changedRooms.add(r.id);
      push({ kind: 'room_reshaped', entityId: r.id, name: r.name }); // 顶点相对位置变了 = 挪墙
    } else if (Math.abs(trans.dx) > MOVE_TOL_MM || Math.abs(trans.dy) > MOVE_TOL_MM) {
      result.changedRooms.add(r.id);
      push({ kind: 'room_moved', entityId: r.id, name: r.name });
    } else if (old.usage !== r.usage) {
      result.changedRooms.add(r.id);
      push({ kind: 'room_reusage', entityId: r.id, name: r.name });
    } else if ((old.occupants ?? null) !== (r.occupants ?? null)) {
      result.changedRooms.add(r.id);
      push({ kind: 'room_occupants', entityId: r.id, name: r.name });
    } else if (old.name !== r.name) {
      result.changedRooms.add(r.id);
      push({ kind: 'room_renamed', entityId: r.id, name: r.name });
    }
  }
  for (const r of a.rooms) {
    if (!rb.has(r.id)) {
      result.removedRooms.add(r.id);
      push({ kind: 'room_removed', entityId: r.id, name: r.name });
    }
  }

  // ---- 设施（按 id 配对；exit 的增删优先于通用设施增删）----
  const fa = new Map(a.facilities.map((f) => [f.id, f]));
  const fb = new Map(b.facilities.map((f) => [f.id, f]));
  for (const f of b.facilities) {
    const old = fa.get(f.id);
    if (!old) {
      result.addedFacilities.add(f.id);
      push({
        kind: f.kind === 'exit' ? 'exit_added' : 'facility_added',
        entityId: f.id,
        name: f.code,
      });
      continue;
    }
    if (old.kind !== f.kind) continue; // 设施类型不会互换
    if (Math.abs(f.x - old.x) > MOVE_TOL_MM || Math.abs(f.y - old.y) > MOVE_TOL_MM) {
      result.changedFacilities.add(f.id);
      push({ kind: 'facility_moved', entityId: f.id, name: f.code });
    }
  }
  for (const f of a.facilities) {
    if (!fb.has(f.id)) {
      result.removedFacilities.add(f.id);
      push({
        kind: f.kind === 'exit' ? 'exit_removed' : 'facility_removed',
        entityId: f.id,
        name: f.code,
      });
    }
  }
  return result;
}

/** 把改动清单压成一句话摘要，如「新增房间 ×2、挪动墙体 ×1」 */
export function summarizeChanges(changes: PlanChange[]): string {
  if (!changes.length) return '无图元改动';
  const order: PlanChange['kind'][] = [
    'exit_added', 'exit_removed',
    'room_added', 'room_removed', 'room_moved', 'room_reshaped',
    'room_reusage', 'room_renamed', 'room_occupants',
    'facility_added', 'facility_removed', 'facility_moved',
  ];
  const counts = new Map<PlanChange['kind'], number>();
  for (const c of changes) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  return order
    .filter((k) => counts.has(k))
    .map((k) => `${PLAN_CHANGE_LABELS[k]} ×${counts.get(k)}`)
    .join('、');
}

// ---------- 合规结论翻转 ----------

/** 影响整体合规结论的校验项（error + 灭火器覆盖，coverage 也参与 pass 判定） */
const FLIP_TYPES = new Set([
  'TRAVEL_EXCEED',
  'DEADEND_EXCEED',
  'EXIT_COUNT',
  'EXIT_NOT_CONNECTED',
  'COVERAGE_UNCOVERED',
]);

export const COMPLIANCE_LABELS: Record<string, string> = {
  TRAVEL_EXCEED: '疏散距离',
  DEADEND_EXCEED: '袋形走道长度',
  EXIT_COUNT: '安全出口数量',
  EXIT_NOT_CONNECTED: '出口与走道连通',
  COVERAGE_UNCOVERED: '灭火器覆盖',
};

export type NameResolver = {
  room: (id?: string) => string | undefined;
  facility: (id?: string) => string | undefined;
};

export function namesOf(snap: FloorSnapshot): NameResolver {
  return {
    room: (id) => (id ? snap.rooms.find((r) => r.id === id)?.name : undefined),
    facility: (id) => (id ? snap.facilities.find((f) => f.id === id)?.code : undefined),
  };
}

export type ComplianceFlip = {
  type: string;
  label: string;
  direction: 'fail_to_pass' | 'pass_to_fail';
  oldValue?: number;
  newValue?: number;
  /** 两版当时的限值（规则可能在两版之间改过，故各自取自当时的校验快照） */
  oldLimit?: number;
  newLimit?: number;
  oldUnit: string;
  newUnit: string;
  oldRuleVersion: number;
  newRuleVersion: number;
  oldRuleSource: string;
  newRuleSource: string;
  message: string;
};

export type ComplianceDiff = {
  oldPass: boolean | null; // null = 该版未校验
  newPass: boolean | null;
  flips: ComplianceFlip[];
};

function violatingItems(v: ValidationResult | null | undefined): Map<string, ValidationItem> {
  const m = new Map<string, ValidationItem>();
  if (!v) return m;
  for (const it of v.items) {
    if (!FLIP_TYPES.has(it.type)) continue;
    m.set(`${it.type}:${it.roomId ?? ''}:${it.facilityId ?? ''}`, it);
  }
  return m;
}

function subjectLabel(type: string, names: NameResolver, roomId?: string, facilityId?: string): string {
  switch (type) {
    case 'TRAVEL_EXCEED': return `${names.room(roomId) ?? '房间'}疏散距离`;
    case 'DEADEND_EXCEED': return '袋形走道长度';
    case 'EXIT_COUNT': return '安全出口数量';
    case 'COVERAGE_UNCOVERED': return '灭火器覆盖面积';
    default: return `安全出口 ${names.facility(facilityId) ?? ''} 连通性`.trim();
  }
}

/** 合格侧（无违规项）的限值从规则快照补取；单位串用于展示 */
function ruleLimit(v: ValidationResult | null | undefined, type: string): { value?: number; unit: string } {
  if (!v) return { unit: '' };
  const rs = v.rulesSnapshot;
  switch (type) {
    case 'TRAVEL_EXCEED': return { value: rs.maxTravelDistanceM, unit: 'm' };
    case 'DEADEND_EXCEED': return { value: rs.deadEndDistanceM, unit: 'm' };
    case 'COVERAGE_UNCOVERED': return { value: rs.extinguisherRadiusM, unit: `m 保护半径` };
    case 'EXIT_COUNT': return { value: rs.exitMinAreaM2, unit: '㎡' };
    default: return { unit: '' };
  }
}

/**
 * 对照两版合规结论：逐条规则按「类型 + 房间/设施」配对，
 * 只报告从合格↔不合规翻转的条目，并携带两版各自的实测值与当时限值
 * （限值取自校验结果快照——规则可能在两版之间改过）。
 */
export function diffCompliance(
  oldV: ValidationResult | null | undefined,
  newV: ValidationResult | null | undefined,
  names: NameResolver,
): ComplianceDiff {
  const oldMap = violatingItems(oldV);
  const newMap = violatingItems(newV);
  const flips: ComplianceFlip[] = [];
  for (const key of new Set([...oldMap.keys(), ...newMap.keys()])) {
    const oi = oldMap.get(key);
    const ni = newMap.get(key);
    if (!!oi === !!ni) continue; // 两版都合格或都不合规（即便限值变了也不算翻转）
    const type = oi?.type ?? ni!.type;
    const roomId = oi?.roomId ?? ni?.roomId;
    const facilityId = oi?.facilityId ?? ni?.facilityId;
    const oldLim = oi?.limit ?? ruleLimit(oldV, type).value;
    const newLim = ni?.limit ?? ruleLimit(newV, type).value;
    const unit =
      type === 'COVERAGE_UNCOVERED' ? '㎡' : type === 'EXIT_COUNT' ? '个' : 'm';
    flips.push({
      type,
      label: subjectLabel(type, names, roomId, facilityId),
      direction: oi && !ni ? 'fail_to_pass' : 'pass_to_fail',
      oldValue: oi?.value ?? (type === 'COVERAGE_UNCOVERED' ? oldV?.coverage?.uncoveredM2 : undefined),
      newValue: ni?.value ?? (type === 'COVERAGE_UNCOVERED' ? newV?.coverage?.uncoveredM2 : undefined),
      oldLimit: oldLim,
      newLimit: newLim,
      oldUnit: unit,
      newUnit: unit,
      oldRuleVersion: oldV?.rulesSnapshot.version ?? 0,
      newRuleVersion: newV?.rulesSnapshot.version ?? 0,
      oldRuleSource: oldV?.rulesSnapshot.source ?? '—',
      newRuleSource: newV?.rulesSnapshot.source ?? '—',
      message: ni?.message ?? oi?.message ?? '',
    });
  }
  flips.sort((a, b) =>
    a.direction === b.direction
      ? a.label.localeCompare(b.label)
      : a.direction === 'pass_to_fail' ? -1 : 1,
  );
  return {
    oldPass: oldV ? oldV.pass : null,
    newPass: newV ? newV.pass : null,
    flips,
  };
}

// ---------- 快照工具 ----------

export function snapshotFloor(f: Pick<Floor, 'rooms' | 'facilities' | 'exits'>): FloorSnapshot {
  return {
    rooms: structuredClone(f.rooms),
    facilities: structuredClone(f.facilities),
    exits: [...f.exits],
  };
}

export function snapshotToFloor(snap: FloorSnapshot, base: Floor): Floor {
  return {
    ...base,
    rooms: snap.rooms,
    facilities: snap.facilities,
    exits: snap.exits,
    underlay: undefined, // 对照视图不加载底图
  };
}
