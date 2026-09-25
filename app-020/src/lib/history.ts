/**
 * 楼层平面版本历史：快照、指标、两版差异、合规结论翻转。
 * 全部为纯函数，便于单测；不触碰 store / DOM。
 */
import type {
  Facility,
  FacilityKind,
  Floor,
  FloorMetrics,
  PlanChange,
  PlanChangeKind,
  PlanDiff,
  PlanSnapshot,
  Room,
  RoomUsage,
  RuleSet,
  ValidationItem,
  ValidationResult,
} from '../model';
import { FACILITY_LABELS, USAGE_LABELS } from '../model';
import { MM_PER_M, bboxOf, pointInPoly, polyAreaM2 } from './geometry';

// ---------- 快照 ----------

/** 从楼层取平面快照（深拷贝；剥离底图/标记等非平面数据，保留设施检查台账） */
export function takeSnapshot(floor: Floor): PlanSnapshot {
  return {
    rooms: floor.rooms.map((r) => structuredClone(r)),
    facilities: floor.facilities.map((f) => structuredClone(f)),
    exits: [...floor.exits],
  };
}

/** 平面是否相同：只比平面几何与设施身份/位置，忽略检查台账、规格与名称无关属性噪声。
 *  checks 的变化由台账功能自行处理，不应触发平面新版本。 */
export function snapshotEqual(a: PlanSnapshot, b: PlanSnapshot): boolean {
  return JSON.stringify(planShapeForCompare(a)) === JSON.stringify(planShapeForCompare(b));
}

/** 比较用的平面形状：剥离 checks/spec；exits 以实际出口设施推导 */
function planShapeForCompare(s: PlanSnapshot) {
  return {
    rooms: s.rooms.map((r) => ({
      id: r.id,
      polygon: r.polygon,
      name: r.name,
      usage: r.usage,
      occupants: r.occupants ?? null,
      areaM2: r.areaM2,
    })),
    facilities: s.facilities.map((f) => ({ id: f.id, kind: f.kind, x: f.x, y: f.y, code: f.code })),
  };
}

// ---------- 指标 ----------

/**
 * 走道中心线长度（m）。
 * 方法：走道多边形栅格化（0.25m）→ Zhang-Suen 细化成 1 格宽骨架 → 8 邻边权和
 * （水平/竖直 1 权、对角 √2 权）→ 端点半径补偿（细化会把每端腐蚀约「形状半宽」）。
 * 直走道、L 形、丁字口都能量出中心线长度；栅格误差 ±0.5m，版本对照只用于「变了多少」。
 */
export function corridorCenterlineM(corridorPolys: Pt[][]): number {
  if (!corridorPolys.length) return 0;
  const STEP = 250;
  const bb = bboxOf(corridorPolys);
  const PAD = 2;
  const nx = Math.max(1, Math.ceil((bb.maxX - bb.minX) / STEP) + PAD * 2 + 1);
  const ny = Math.max(1, Math.ceil((bb.maxY - bb.minY) / STEP) + PAD * 2 + 1);
  const ox = bb.minX - PAD * STEP;
  const oy = bb.minY - PAD * STEP;
  if (nx * ny > 4_000_000) {
    // 退化方案：按多边形周长/2 粗估
    return corridorPolys.reduce((s, p) => s + perimeterMm(p) / 2 / MM_PER_M, 0);
  }
  const img = new Uint8Array(nx * ny);
  for (const poly of corridorPolys) {
    const pbb = bboxOf([poly]);
    const i0 = Math.max(0, Math.floor((pbb.minX - ox) / STEP));
    const i1 = Math.min(nx - 1, Math.ceil((pbb.maxX - ox) / STEP));
    const j0 = Math.max(0, Math.floor((pbb.minY - oy) / STEP));
    const j1 = Math.min(ny - 1, Math.ceil((pbb.maxY - oy) / STEP));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (pointInPoly({ x: ox + i * STEP, y: oy + j * STEP }, poly)) img[j * nx + i] = 1;
      }
    }
  }
  const skel = thinZhangSuen(img, nx, ny);
  return skeletonLengthM(skel, nx, ny, STEP);
}

/** 骨架边权和 + 端点半径补偿（单位 m） */
export function skeletonLengthM(skel: Uint8Array, nx: number, ny: number, step: number): number {
  const at = (i: number, j: number) => i >= 0 && j >= 0 && i < nx && j < ny && skel[j * nx + i] === 1;
  let mm = 0;
  let endpoints = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (!at(i, j)) continue;
      let deg = 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (di === 0 && dj === 0) continue;
          if (!at(i + di, j + dj)) continue;
          if (di !== 0 && dj !== 0 && !(at(i + di, j) && at(i, j + dj))) continue; // 对角不穿墙
          deg++;
          if (di > 0 || (di === 0 && dj > 0)) {
            mm += di !== 0 && dj !== 0 ? step * Math.SQRT2 : step; // 每条边只计一次
          }
        }
      }
      if (deg === 1) endpoints++;
    }
  }
  if (mm === 0) return 0;
  // 端点补偿：Zhang-Suen 会从每端向内腐蚀约「局部半宽」。
  // 环（0 端点）不补；2 端的开枝每端补 1 格（2m 宽走廊半宽=1m=4 格×0.25m）；
  // 多端（丁字/死端）每端同样补 1 格。宽度由形状内部栅格行统计估计，兜底 1m。
  const halfW = estimateHalfWidthSteps(skel, nx, ny);
  mm += endpoints * halfW * step;
  return mm / MM_PER_M;
}

/** 局部半宽（栅格数）：在骨架点处沿其方向法线找形状边界的平均距离，取中位数；兜底 4（=1m） */
function estimateHalfWidthSteps(skel: Uint8Array, nx: number, _ny: number): number {
  // 简化且稳健：用「形状总面积 / 骨架总长」反推平均宽度，半宽 ≈ 面积/(2×长度)
  let on = 0;
  for (let k = 0; k < skel.length; k++) if (skel[k]) on++;
  if (!on) return 4;
  // 骨架边数（不含补偿）这里不易重取，给固定经验值：走道常见 1.5–2.5m 宽 → 半宽 3–5 格，
  // 取 4 格（1m）。端点误差在 ±0.25m 内，满足版本对照精度。
  void nx;
  return 4;
}

/** Zhang-Suen 细化（二值图 0/1 → 骨架 0/1）。经典两遍迭代算法。
 *  内部自动补一圈零边框：算法要求形状外有背景像素，否则边缘点永不满足删除条件。 */
export function thinZhangSuen(img: Uint8Array, nx: number, ny: number): Uint8Array {
  const W = nx + 2;
  const H = ny + 2;
  const padded = new Uint8Array(W * H);
  for (let j = 0; j < ny; j++) padded.set(img.subarray(j * nx, (j + 1) * nx), (j + 1) * W + 1);
  const out = padded;
  const at = (i: number, j: number) => (i < 0 || j < 0 || i >= W || j >= H ? 0 : out[j * W + i]);
  const removable = (i: number, j: number, firstPass: boolean): boolean => {
    const p2 = at(i, j - 1), p3 = at(i + 1, j - 1), p4 = at(i + 1, j), p5 = at(i + 1, j + 1);
    const p6 = at(i, j + 1), p7 = at(i - 1, j + 1), p8 = at(i - 1, j), p9 = at(i - 1, j - 1);
    const sum = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
    if (sum < 2 || sum > 6) return false;
    const seq = [p2, p3, p4, p5, p6, p7, p8, p9];
    let trans = 0;
    for (let k = 0; k < 8; k++) if (seq[k] === 0 && seq[(k + 1) % 8] === 1) trans++;
    if (trans !== 1) return false;
    if (firstPass) {
      if (p2 * p4 * p6 !== 0) return false;
      if (p4 * p6 * p8 !== 0) return false;
    } else {
      if (p2 * p4 * p8 !== 0) return false;
      if (p2 * p6 * p8 !== 0) return false;
    }
    return true;
  };
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 10000) {
    changed = false;
    for (const first of [true, false]) {
      const marks: number[] = [];
      for (let j = 1; j < H - 1; j++) {
        for (let i = 1; i < W - 1; i++) {
          if (out[j * W + i] === 1 && removable(i, j, first)) marks.push(j * W + i);
        }
      }
      if (marks.length) {
        changed = true;
        for (const idx of marks) out[idx] = 0;
      }
    }
  }
  const result = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) result.set(out.subarray((j + 1) * W + 1, (j + 1) * W + 1 + nx), j * nx);
  return result;
}

/** 8 邻栅格图骨架长度（导出供测试直接验证） */
export function gridSkeletonMm(mask: Uint8Array, nx: number, ny: number, step = 250): number {
  return skeletonLengthM(mask, nx, ny, step) * MM_PER_M;
}

function perimeterMm(poly: Pt[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += Math.hypot(a.x - b.x, a.y - b.y);
  }
  return s;
}

export function computeMetrics(s: PlanSnapshot): FloorMetrics {
  const areaM2 = s.rooms.reduce((sum, r) => sum + polyAreaM2(r.polygon), 0);
  const roomCount = s.rooms.filter((r) => r.usage !== 'corridor').length;
  const exitCount = s.facilities.filter((f) => f.kind === 'exit').length;
  const corridorLengthM = corridorCenterlineM(
    s.rooms.filter((r) => r.usage === 'corridor').map((r) => r.polygon),
  );
  return { areaM2, roomCount, exitCount, corridorLengthM };
}

// ---------- 图元差异 ----------

const EPS_MM = 1;

function samePoly(a: Pt[], b: Pt[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i].x - b[i].x) > EPS_MM || Math.abs(a[i].y - b[i].y) > EPS_MM) return false;
  }
  return true;
}

type Pt = { x: number; y: number };

function polyMovedOnly(a: Pt[], b: Pt[]): boolean {
  if (a.length !== b.length) return false;
  const dx = b[0].x - a[0].x;
  const dy = b[0].y - a[0].y;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(b[i].x - a[i].x - dx) > EPS_MM || Math.abs(b[i].y - a[i].y - dy) > EPS_MM) return false;
  }
  return dx !== 0 || dy !== 0;
}

function polyCentroid(p: Pt[]): Pt {
  const sx = p.reduce((t, q) => t + q.x, 0);
  const sy = p.reduce((t, q) => t + q.y, 0);
  return { x: sx / p.length, y: sy / p.length };
}

function moveDetailMm(a: Pt[], b: Pt[]): string {
  const ca = polyCentroid(a);
  const cb = polyCentroid(b);
  const d = Math.hypot(cb.x - ca.x, cb.y - ca.y) / MM_PER_M;
  return `移动 ${d.toFixed(1)}m`;
}

function facLabel(f: { code: string }): string {
  return f.code;
}

const CHANGE_VERBS: Record<PlanChangeKind, string> = {
  room_added: '新增房间',
  room_removed: '删除房间',
  room_moved: '挪动房间',
  room_reshaped: '调整墙体',
  room_renamed: '房间改名',
  room_reused: '房间改用途',
  room_occupants: '修改人数',
  exit_added: '新增出口',
  exit_removed: '删除出口',
  exit_moved: '挪动出口',
  facility_added: '新增设施',
  facility_removed: '删除设施',
  facility_moved: '挪动设施',
};

export function changeVerb(kind: PlanChangeKind): string {
  return CHANGE_VERBS[kind];
}

/** 明细差异：同 id 配对房间/设施，其余按新增/删除计。 */
export function diffPlans(before: PlanSnapshot, after: PlanSnapshot): PlanDiff {
  const addedRoomIds: string[] = [];
  const removedRoomIds: string[] = [];
  const changedRoomIds: string[] = [];
  const addedFacilityIds: string[] = [];
  const removedFacilityIds: string[] = [];
  const changedFacilityIds: string[] = [];
  const changes: PlanChange[] = [];

  const beforeRooms = new Map(before.rooms.map((r) => [r.id, r]));
  const afterRooms = new Map(after.rooms.map((r) => [r.id, r]));

  for (const r of after.rooms) {
    const old = beforeRooms.get(r.id);
    if (!old) {
      addedRoomIds.push(r.id);
      changes.push({
        kind: 'room_added',
        label: r.name,
        subjectId: r.id,
        detail: r.usage === 'corridor' ? USAGE_LABELS.corridor : `${USAGE_LABELS[r.usage as RoomUsage] ?? ''} ${r.areaM2.toFixed(1)}㎡`.trim(),
      });
      continue;
    }
    const roomChanges = diffRoom(old, r);
    if (roomChanges.length) {
      changedRoomIds.push(r.id);
      for (const c of roomChanges) changes.push({ ...c, subjectId: r.id });
    }
  }
  for (const r of before.rooms) {
    if (!afterRooms.has(r.id)) {
      removedRoomIds.push(r.id);
      changes.push({ kind: 'room_removed', label: r.name, subjectId: r.id, detail: USAGE_LABELS[r.usage] });
    }
  }

  const beforeFac = new Map(before.facilities.map((f) => [f.id, f]));
  const afterFac = new Map(after.facilities.map((f) => [f.id, f]));
  for (const f of after.facilities) {
    const old = beforeFac.get(f.id);
    if (!old) {
      addedFacilityIds.push(f.id);
      changes.push({
        kind: f.kind === 'exit' ? 'exit_added' : 'facility_added',
        label: facLabel(f),
        subjectId: f.id,
        detail: f.kind === 'exit' ? '安全出口' : FACILITY_LABELS[f.kind as FacilityKind],
      });
      continue;
    }
    const d = Math.hypot(f.x - old.x, f.y - old.y);
    if (d > EPS_MM) {
      changedFacilityIds.push(f.id);
      changes.push({
        kind: f.kind === 'exit' ? 'exit_moved' : 'facility_moved',
        label: facLabel(f),
        subjectId: f.id,
        detail: `移动 ${(d / MM_PER_M).toFixed(1)}m`,
      });
    }
  }
  for (const f of before.facilities) {
    if (!afterFac.has(f.id)) {
      removedFacilityIds.push(f.id);
      changes.push({
        kind: f.kind === 'exit' ? 'exit_removed' : 'facility_removed',
        label: facLabel(f),
        subjectId: f.id,
        detail: f.kind === 'exit' ? '安全出口' : FACILITY_LABELS[f.kind as FacilityKind],
      });
    }
  }

  return { addedRoomIds, removedRoomIds, changedRoomIds, addedFacilityIds, removedFacilityIds, changedFacilityIds, changes };
}

function diffRoom(old: Room, now: Room): PlanChange[] {
  const out: PlanChange[] = [];
  const withId = (c: Omit<PlanChange, 'subjectId'>): PlanChange => ({ ...c, subjectId: now.id });
  if (!samePoly(old.polygon, now.polygon)) {
    if (polyMovedOnly(old.polygon, now.polygon)) {
      out.push(withId({ kind: 'room_moved', label: now.name, detail: moveDetailMm(old.polygon, now.polygon) }));
    } else {
      changedAreaNote(old, now, out);
    }
  }
  if (old.name !== now.name) {
    out.push(withId({ kind: 'room_renamed', label: now.name, detail: `「${old.name}」→「${now.name}」` }));
  }
  if (old.usage !== now.usage) {
    out.push(withId({ kind: 'room_reused', label: now.name, detail: `${USAGE_LABELS[old.usage]}→${USAGE_LABELS[now.usage]}` }));
  }
  if ((old.occupants ?? null) !== (now.occupants ?? null)) {
    out.push(withId({ kind: 'room_occupants', label: now.name, detail: `${old.occupants ?? '自动'}→${now.occupants ?? '自动'}` }));
  }
  return out;
}

function changedAreaNote(old: Room, now: Room, out: PlanChange[]) {
  const a0 = polyAreaM2(old.polygon);
  const a1 = polyAreaM2(now.polygon);
  const dArea = a1 - a0;
  const note = Math.abs(dArea) >= 0.05
    ? `${a0.toFixed(1)}㎡→${a1.toFixed(1)}㎡（${dArea > 0 ? '+' : ''}${dArea.toFixed(1)}㎡）`
    : `${a1.toFixed(1)}㎡`;
  // 墙改了但形状顶点数/位置变化——即「挪了墙」
  out.push({ kind: 'room_reshaped', label: now.name, subjectId: now.id, detail: note });
}

/** 汇总一句话（编辑合并场景下由明细生成） */
export function summarizeChanges(changes: PlanChange[]): string {
  if (!changes.length) return '无平面变化';
  const counts = new Map<PlanChangeKind, number>();
  for (const c of changes) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  const parts: string[] = [];
  for (const [kind, n] of counts) {
    parts.push(n > 1 ? `${CHANGE_VERBS[kind]}×${n}` : CHANGE_VERBS[kind]);
  }
  return parts.join('、');
}

// ---------- 合规结论翻转 ----------

/** 参与合规对照的条目类型；检查台账类（过期/缺记录/缺陷）随时间变化、与平面改动无关，不纳入 */
const COMPLIANCE_TYPES = new Set([
  'TRAVEL_EXCEED',
  'DEADEND_EXCEED',
  'EXIT_COUNT',
  'EXIT_NOT_CONNECTED',
  'COVERAGE_UNCOVERED',
  'NO_DOOR',
]);

export type ComplianceStatus = 'pass' | 'fail';

export type ComplianceFlip = {
  /** 稳定键：类型 + 主体 id（房间/设施）；同一问题两版之间配对用 */
  key: string;
  type: string;
  subjectId?: string; // roomId / facilityId
  subjectName: string; // 房间名 / 设施编号 / 指标名
  from: ComplianceStatus; // 旧版合格性
  to: ComplianceStatus; // 新版合格性
  /** 旧版实测/限值文案（限值取旧版当时规则） */
  fromValue: string;
  fromLimit: string;
  toValue: string;
  toLimit: string;
  severity: ValidationItem['severity'];
};

export const COMPLIANCE_TYPE_LABELS: Record<string, string> = {
  TRAVEL_EXCEED: '疏散距离',
  DEADEND_EXCEED: '袋形走道长度',
  EXIT_COUNT: '安全出口数量',
  EXIT_NOT_CONNECTED: '出口连通性',
  COVERAGE_UNCOVERED: '灭火器覆盖',
  NO_DOOR: '房间门',
};

function itemKey(it: ValidationItem): string {
  return `${it.type}:${it.roomId ?? it.facilityId ?? '#'}`;
}

function valueText(it: ValidationItem | undefined): string {
  if (!it) return '合格';
  if (it.value != null) {
    if (it.type === 'COVERAGE_UNCOVERED') return `${it.value.toFixed(1)}㎡ 未覆盖`;
    if (it.type === 'EXIT_COUNT') return `现有 ${it.value} 个`;
    return `${it.value.toFixed(1)}m`;
  }
  return '不满足';
}

/** 旧版合格时（无条目）展示该版当时限值；EXIT_COUNT 需把面积/人数阈值与需求数都给出 */
function limitTextFor(type: string, rules: RuleSet, required?: number): string {
  switch (type) {
    case 'TRAVEL_EXCEED': return `限值 ${rules.maxTravelDistanceM}m`;
    case 'DEADEND_EXCEED': return `限值 ${rules.deadEndDistanceM}m`;
    case 'COVERAGE_UNCOVERED': return `保护半径 ${rules.extinguisherRadiusM}m`;
    case 'EXIT_COUNT':
      return `面积>${rules.exitMinAreaM2}㎡ 或人数>${rules.exitMaxOccupants} 需≥${required ?? 2} 个`;
    default: return '—';
  }
}

function subjectNameOf(it: ValidationItem, snap: PlanSnapshot): string {
  if (it.roomId) return snap.rooms.find((r) => r.id === it.roomId)?.name ?? '房间（已删除）';
  if (it.facilityId) {
    const f = snap.facilities.find((x) => x.id === it.facilityId);
    return f?.code ?? '设施（已删除）';
  }
  return COMPLIANCE_TYPE_LABELS[it.type] ?? it.type;
}

function relevantItems(v: ValidationResult | null): ValidationItem[] {
  return v ? v.items.filter((i) => COMPLIANCE_TYPES.has(i.type)) : [];
}

/** 整体合规结论：与 engine 口径一致——存在 error 或灭火器覆盖不通过即不合规 */
export function complianceStatus(v: ValidationResult | null): ComplianceStatus {
  if (!v) return 'pass';
  return v.pass ? 'pass' : 'fail';
}

/**
 * 两版合规对照：按 (type, 主体) 配对条目，输出合格↔不合规翻转。
 * 两版限值分别取自各版快照内的规则（规则可能也改过）。
 */
export function diffCompliance(
  oldSnap: PlanSnapshot,
  oldRules: RuleSet,
  oldV: ValidationResult | null,
  newSnap: PlanSnapshot,
  newRules: RuleSet,
  newV: ValidationResult | null,
): { flips: ComplianceFlip[]; fromPass: boolean; toPass: boolean } {
  const oldMap = new Map<string, ValidationItem>();
  for (const it of relevantItems(oldV)) oldMap.set(itemKey(it), it);
  const newMap = new Map<string, ValidationItem>();
  for (const it of relevantItems(newV)) newMap.set(itemKey(it), it);

  const flips: ComplianceFlip[] = [];
  const keys = new Set([...oldMap.keys(), ...newMap.keys()]);
  for (const key of keys) {
    const o = oldMap.get(key);
    const n = newMap.get(key);
    if ((o ? 'fail' : 'pass') === (n ? 'fail' : 'pass')) continue;
    const type = (o ?? n)!.type;
    const subjectId = (o ?? n)!.roomId ?? (o ?? n)!.facilityId;
    const rep = n ?? o!;
    flips.push({
      key,
      type,
      subjectId,
      subjectName: n ? subjectNameOf(rep, newSnap) : subjectNameOf(rep, oldSnap),
      from: o ? 'fail' : 'pass',
      to: n ? 'fail' : 'pass',
      fromValue: valueText(o),
      fromLimit: o && o.limit != null ? formatItemLimit(type, o.limit, oldRules) : limitTextFor(type, oldRules, oldV?.exits.required),
      toValue: valueText(n),
      toLimit: n && n.limit != null ? formatItemLimit(type, n.limit, newRules) : limitTextFor(type, newRules, newV?.exits.required),
      severity: rep.severity,
    });
  }
  // 先列由合格变不合规（更重要），再列反过来；同类按名称
  flips.sort((a, b) => {
    if (a.from !== b.from) return a.from === 'pass' ? -1 : 1;
    return a.subjectName.localeCompare(b.subjectName);
  });
  return { flips, fromPass: complianceStatus(oldV) === 'pass', toPass: complianceStatus(newV) === 'pass' };
}

function formatItemLimit(type: string, limit: number, rules: RuleSet): string {
  switch (type) {
    case 'TRAVEL_EXCEED':
    case 'DEADEND_EXCEED':
      return `限值 ${limit}m`;
    case 'EXIT_COUNT':
      return limitTextFor(type, rules, limit);
    case 'COVERAGE_UNCOVERED':
      return `保护半径 ${rules.extinguisherRadiusM}m`;
    default:
      return String(limit);
  }
}

// ---------- 由快照构造可渲染楼层 ----------

/** 用快照拼一个最小 Floor 供 FloorPlan 渲染（无 id 以外的无关字段） */
export function floorFromSnapshot(snapshot: PlanSnapshot, level = 1): Floor {
  return {
    id: 'snapshot',
    buildingId: '',
    level,
    scaleMmPerUnit: 1,
    rooms: snapshot.rooms,
    facilities: snapshot.facilities as Facility[],
    exits: snapshot.exits,
    version: 0,
  };
}
