import { useSyncExternalStore } from 'react';
import type {
  Building,
  BuildingKind,
  CheckRecord,
  Facility,
  FacilityKind,
  Floor,
  FloorRevision,
  FloorSnapshot,
  PlanChange,
  Pt,
  Room,
  RoomUsage,
  RuleSet,
  ValidationResult,
} from '../model';
import { DEFAULT_RULES } from '../rules/defaults';
import { nextCode, uid } from './id';
import { polyAreaM2 } from '../lib/geometry';
import { diffPlans, floorMetrics, snapshotFloor, summarizeChanges } from '../lib/history';

const STORAGE_KEY = 'fem.v1';

export type AppState = {
  buildings: Building[];
  floors: Record<string, Floor>;
  rules: Record<BuildingKind, RuleSet>;
  /** 「您在此」标记（打印版疏散图），按楼层存 */
  marks: Record<string, Pt>;
};

function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<AppState>;
      // 缺失的节用默认值补齐（如旧版本数据没有 rules/marks），而不是整体丢弃用户数据
      if (s && Array.isArray(s.buildings) && s.floors) {
        // 旧版本数据没有 history：把当前平面补成初始版本，历史从此刻开始记
        for (const f of Object.values(s.floors)) {
          if (f && !f.history) {
            const snap = snapshotFloor(f);
            f.history = [
              {
                seq: 1,
                createdAt: new Date().toISOString(),
                summary: '初始版本（升级前数据）',
                changes: [],
                origin: 'edit',
                snapshot: snap,
                metrics: floorMetrics(snap),
                validation: f.lastValidation ? structuredClone(f.lastValidation) : null,
              },
            ];
            f.historySeq = 1;
          }
        }
        return {
          buildings: s.buildings,
          floors: s.floors,
          rules: { ...structuredClone(DEFAULT_RULES), ...(s.rules ?? {}) },
          marks: s.marks ?? {},
        };
      }
    }
  } catch {
    /* 损坏则重新开始 */
  }
  return { buildings: [], floors: {}, rules: structuredClone(DEFAULT_RULES), marks: {} };
}

let state: AppState = loadState();
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function persist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* 存储满时忽略（照片/底图在 IndexedDB，不受影响） */
    }
  }, 200);
}

function setState(patch: (s: AppState) => void) {
  patch(state);
  // 浅拷贝各容器：保证 s.buildings / s.floors / s.rules / s.marks 选择器拿到新引用
  state = {
    buildings: [...state.buildings],
    floors: { ...state.floors },
    rules: { ...state.rules },
    marks: { ...state.marks },
  };
  persist();
  listeners.forEach((l) => l());
}

export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getState(): AppState {
  return state;
}

export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

/**
 * 平面几何类改动的统一入口（画完/拖完/放置这类离散动作，立即落版）：
 * 1. 若有尚未落版的属性输入，先冲掉它（属性单独成版）；
 * 2. 取改动前快照做 diff（挪墙/加房间/换出口……），无图元改动则只 bump version；
 * 3. 追加一版历史（带上改动摘要与指标），校验结果待编辑器自动校验后回写该版；
 * 4. 替换楼层引用，保证订阅者刷新。
 * 非几何改动（检查记录、设施规格、底图）请直接用 updateFloorMeta；
 * 房间属性输入（改名/用途/人数）请用 scheduleRoomAttrEdit 防抖合并。
 */
const HISTORY_LIMIT = 100; // 每层最多保留版本数（回退版也算，超出只丢最早的，不影响回退）
/**
 * 属性输入防抖：短于编辑器的 500ms 校验防抖——保证版本先生成，
 * 随后那次自动校验的结果会回写进这一版，而不是污染上一版。
 */
const ATTR_COMMIT_DELAY_MS = 400;

/** 尚未落版的属性编辑：floorId → 改动前快照（这一版 diff 的基线） */
const pendingAttr = new Map<string, FloorSnapshot>();
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

function appendRevision(f: Floor, before: FloorSnapshot, after: FloorSnapshot, changes: PlanChange[], extra?: Partial<FloorRevision>) {
  const seq = (f.history?.length ? f.history[f.history.length - 1].seq : 0) + 1;
  const rev: FloorRevision = {
    seq,
    createdAt: new Date().toISOString(),
    summary: summarizeChanges(changes),
    changes,
    origin: 'edit',
    snapshot: after,
    metrics: floorMetrics(after),
    validation: null,
    ...extra,
  };
  f.history = [...(f.history ?? baselineHistory(before)), rev].slice(-HISTORY_LIMIT);
  f.historySeq = seq;
}

/** 把挂起的属性编辑冲成一版（几何改动/回退/删除前先调） */
function flushPendingAttr(floorId: string) {
  const timer = pendingTimers.get(floorId);
  if (timer) {
    clearTimeout(timer);
    pendingTimers.delete(floorId);
  }
  if (!pendingAttr.has(floorId)) return;
  setState((s) => {
    const f = s.floors[floorId];
    const before = pendingAttr.get(floorId);
    pendingAttr.delete(floorId);
    if (!f || !before) return;
    const after = snapshotFloor(f);
    const diff = diffPlans(before, after);
    if (diff.changes.length) appendRevision(f, before, after, diff.changes);
    s.floors[floorId] = { ...f };
  });
}

function commitPlan(floorId: string, mut: (f: Floor) => void): boolean {
  flushPendingAttr(floorId);
  let changed = false;
  setState((s) => {
    const f = s.floors[floorId];
    if (!f) return;
    const before = snapshotFloor(f);
    mut(f);
    const after = snapshotFloor(f);
    const diff = diffPlans(before, after);
    f.version++;
    if (!diff.changes.length) {
      s.floors[floorId] = { ...f }; // 引用语义：即便无落版也要让订阅者感知
      return;
    }
    changed = true;
    appendRevision(f, before, after, diff.changes);
    s.floors[floorId] = { ...f };
  });
  return changed;
}

/**
 * 房间属性编辑（改名/用途/人数）来自输入框的连续按键：
 * 先把改动同步写到当前平面（输入框即时响应、引用立即更新），
 * 但延迟合并成一版历史，连续输入只产生一个版本。
 */
function scheduleRoomAttrEdit(floorId: string, mut: (f: Floor) => void) {
  setState((s) => {
    const f = s.floors[floorId];
    if (!f) return;
    if (!pendingAttr.has(floorId)) pendingAttr.set(floorId, snapshotFloor(f));
    mut(f);
    f.version++;
    s.floors[floorId] = { ...f };
  });
  const oldTimer = pendingTimers.get(floorId);
  if (oldTimer) clearTimeout(oldTimer);
  pendingTimers.set(
    floorId,
    setTimeout(() => {
      pendingTimers.delete(floorId);
      flushPendingAttr(floorId);
    }, ATTR_COMMIT_DELAY_MS),
  );
}

function baselineHistory(snap: FloorSnapshot): FloorRevision[] {
  return [
    {
      seq: 1,
      createdAt: new Date().toISOString(),
      summary: '初始版本',
      changes: [],
      origin: 'edit',
      snapshot: snap,
      metrics: floorMetrics(snap),
      validation: null,
    },
  ];
}

/** 非几何类改动（检查记录/设施规格/底图）：只 bump version 触发校验，不产生新版本 */
function updateFloorMeta(floorId: string, mut: (f: Floor) => void) {
  setState((s) => {
    const f = s.floors[floorId];
    if (!f) return;
    mut(f);
    s.floors[floorId] = { ...f };
  });
}

// ---------- 建筑 ----------

export function addBuilding(name: string, kind: BuildingKind): string {
  const id = uid();
  const b: Building = { id, name, kind, floors: [], createdAt: new Date().toISOString() };
  setState((s) => s.buildings.push(b));
  return id;
}

export function updateBuilding(id: string, patch: Partial<Pick<Building, 'name' | 'kind'>>) {
  setState((s) => {
    const i = s.buildings.findIndex((x) => x.id === id);
    if (i >= 0) s.buildings[i] = { ...s.buildings[i], ...patch };
  });
}

export function deleteBuilding(id: string) {
  setState((s) => {
    const b = s.buildings.find((x) => x.id === id);
    if (!b) return;
    for (const fid of b.floors) {
      const timer = pendingTimers.get(fid);
      if (timer) clearTimeout(timer);
      pendingTimers.delete(fid);
      pendingAttr.delete(fid);
      delete s.floors[fid];
    }
    s.buildings = s.buildings.filter((x) => x.id !== id);
  });
}

// ---------- 楼层 ----------

export function addFloor(buildingId: string, level: number): string {
  const id = uid();
  const snap: FloorSnapshot = { rooms: [], facilities: [], exits: [] };
  const floor: Floor = {
    id,
    buildingId,
    level,
    scaleMmPerUnit: 1,
    rooms: [],
    facilities: [],
    exits: [],
    version: 0,
    history: [
      {
        seq: 1,
        createdAt: new Date().toISOString(),
        summary: '初始版本（空楼层）',
        changes: [],
        origin: 'edit',
        snapshot: structuredClone(snap),
        metrics: floorMetrics(snap),
        validation: null,
      },
    ],
    historySeq: 1,
  };
  setState((s) => {
    s.floors[id] = floor;
    const bi = s.buildings.findIndex((x) => x.id === buildingId);
    if (bi >= 0) s.buildings[bi] = { ...s.buildings[bi], floors: [...s.buildings[bi].floors, id] };
  });
  return id;
}

export function deleteFloor(floorId: string) {
  flushPendingAttr(floorId);
  setState((s) => {
    const f = s.floors[floorId];
    if (!f) return;
    const bi = s.buildings.findIndex((x) => x.id === f.buildingId);
    if (bi >= 0) {
      s.buildings[bi] = { ...s.buildings[bi], floors: s.buildings[bi].floors.filter((x) => x !== floorId) };
    }
    pendingTimers.delete(floorId);
    pendingAttr.delete(floorId);
    delete s.floors[floorId];
    delete s.marks[floorId];
  });
}

// ---------- 房间 ----------

export function addRoom(floorId: string, polygon: Pt[], name: string, usage: RoomUsage): string {
  const id = uid();
  commitPlan(floorId, (f) => {
    f.rooms.push({ id, polygon, name, usage, areaM2: polyAreaM2(polygon) });
  });
  return id;
}

export function updateRoom(floorId: string, roomId: string, patch: Partial<Pick<Room, 'name' | 'usage' | 'occupants'>>) {
  scheduleRoomAttrEdit(floorId, (f) => {
    const r = f.rooms.find((x) => x.id === roomId);
    if (r) Object.assign(r, patch);
  });
}

export function deleteRoom(floorId: string, roomId: string) {
  commitPlan(floorId, (f) => {
    f.rooms = f.rooms.filter((x) => x.id !== roomId);
  });
}

/** 拖动整体平移房间多边形（保留 id、人数等属性与数组顺序） */
export function moveRoom(floorId: string, roomId: string, dx: number, dy: number) {
  if (dx === 0 && dy === 0) return;
  commitPlan(floorId, (f) => {
    const r = f.rooms.find((x) => x.id === roomId);
    if (!r) return;
    r.polygon = r.polygon.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  });
}

// ---------- 设施 ----------

export function addFacility(floorId: string, kind: FacilityKind, x: number, y: number): string {
  const id = uid();
  commitPlan(floorId, (f) => {
    const fac: Facility = { id, kind, x, y, code: nextCode(f, kind), checks: [] };
    if (kind === 'extinguisher') fac.spec = { extType: 'dry_powder', weightKg: 4 };
    f.facilities.push(fac);
    if (kind === 'exit') f.exits.push(id);
  });
  return id;
}

export function moveFacility(floorId: string, facilityId: string, x: number, y: number) {
  commitPlan(floorId, (f) => {
    const fac = f.facilities.find((x2) => x2.id === facilityId);
    if (fac) {
      fac.x = x;
      fac.y = y;
    }
  });
}

/** 设施规格（灭火器类型/公斤数）不改动图面几何，不产生新版本 */
export function updateFacility(floorId: string, facilityId: string, patch: Partial<Pick<Facility, 'spec'>>) {
  updateFloorMeta(floorId, (f) => {
    const fac = f.facilities.find((x) => x.id === facilityId);
    if (fac && patch.spec) {
      fac.spec = patch.spec;
      f.version++;
    }
  });
}

export function deleteFacility(floorId: string, facilityId: string) {
  commitPlan(floorId, (f) => {
    f.facilities = f.facilities.filter((x) => x.id !== facilityId);
    f.exits = f.exits.filter((x) => x !== facilityId);
  });
}

export function addCheck(floorId: string, facilityId: string, check: CheckRecord) {
  updateFloorMeta(floorId, (f) => {
    const fac = f.facilities.find((x) => x.id === facilityId);
    if (fac) {
      fac.checks.push(check);
      f.version++;
    }
  });
}

export function deleteCheck(floorId: string, facilityId: string, index: number) {
  updateFloorMeta(floorId, (f) => {
    const fac = f.facilities.find((x) => x.id === facilityId);
    if (fac) {
      fac.checks.splice(index, 1);
      f.version++;
    }
  });
}

// ---------- 底图 / 标记 / 校验结果 ----------

export function setUnderlay(floorId: string, underlay: Floor['underlay']) {
  updateFloorMeta(floorId, (f) => {
    f.underlay = underlay;
  });
}

export function setMark(floorId: string, pt: Pt) {
  setState((s) => {
    s.marks[floorId] = { ...pt };
  });
}

/**
 * 写入自动校验结果：只回写到「当前平面对应的那一版」。
 * 这样规则在两版之间改过、重新校验当前平面时，旧版冻结的仍是当时规则下的结论；
 * 检查记录等非几何改动引起的重校验不会污染当前版的冻结结论。
 */
export function setLastValidation(floorId: string, result: ValidationResult) {
  setState((s) => {
    const f = s.floors[floorId];
    if (!f) return;
    f.lastValidation = result;
    if (f.history?.length) {
      const idx = f.history.length - 1;
      const last = f.history[idx];
      // 替换修订对象本身（而不是原地改字段），对照页 useMemo 才能感知冻结结论更新
      if (last.seq === f.historySeq) {
        f.history = [...f.history.slice(0, idx), { ...last, validation: structuredClone(result) }];
      }
    }
    s.floors[floorId] = { ...f };
  });
}

// ---------- 版本回退 ----------

/**
 * 一键回退到指定历史版本：
 * - 几何（房间/设施/出口）恢复为该版快照，id 保持不变以便两版继续按 id 对照；
 * - 设施检查记录与规格不在版本管控范围内，按 id 合并保留（回退不丢台账）；
 * - 回退本身追加为一个新版本（origin: 'rollback'），历史一条不删。
 */
export function rollbackFloor(floorId: string, seq: number): boolean {
  flushPendingAttr(floorId);
  let ok = false;
  setState((s) => {
    const f = s.floors[floorId];
    if (!f || !f.history) return;
    const target = f.history.find((r) => r.seq === seq);
    if (!target) return;
    const curLast = f.history[f.history.length - 1];
    const checksById = new Map(f.facilities.map((x) => [x.id, x]));
    const facilities = target.snapshot.facilities.map((x) => {
      const cur = checksById.get(x.id);
      // 恢复几何与编号，保留当前的检查记录（规格是快照的一部分，以快照为准）
      return cur ? { ...structuredClone(x), checks: cur.checks } : structuredClone(x);
    });
    f.rooms = structuredClone(target.snapshot.rooms);
    f.facilities = facilities;
    f.exits = [...target.snapshot.exits];
    f.version++;

    const newSnap = snapshotFloor(f);
    const changes = diffPlans(curLast.snapshot, newSnap).changes;
    appendRevision(f, curLast.snapshot, newSnap, changes, {
      summary: `回退到 v${seq}（${target.summary}）`,
      origin: 'rollback',
      rolledBackFrom: curLast.seq,
      restoredSeq: seq,
    });
    ok = true;
    s.floors[floorId] = { ...f };
  });
  return ok;
}

// ---------- 规则 ----------

export function updateRules(kind: BuildingKind, patch: Partial<Omit<RuleSet, 'buildingKind' | 'version'>>) {
  setState((s) => {
    const r = s.rules[kind];
    s.rules[kind] = { ...r, ...patch, version: r.version + 1 };
  });
}

export function resetRules(kind: BuildingKind) {
  setState((s) => {
    s.rules[kind] = structuredClone(DEFAULT_RULES[kind]);
  });
  persist();
}

// ---------- 示例数据 ----------

const M = 1000;
function rect(x: number, y: number, w: number, h: number): Pt[] {
  return [
    { x: x * M, y: y * M },
    { x: (x + w) * M, y: y * M },
    { x: (x + w) * M, y: (y + h) * M },
    { x: x * M, y: (y + h) * M },
  ];
}

/** 载入示例：41m 走道双出口 + 10 个房间，办公楼规则全过；切换厂房规则后灭火器覆盖不合规 */
export function loadDemo(): string {
  let bid = '';
  setState((s) => {
    const buildingId = uid();
    bid = buildingId;
    const floorId = uid();
    s.buildings.push({
      id: buildingId,
      name: '示例办公楼',
      kind: 'office',
      floors: [floorId],
      createdAt: new Date().toISOString(),
    });
    const rooms: Room[] = [];
    const mk = (name: string, usage: RoomUsage, poly: Pt[], occupants?: number) => {
      rooms.push({ id: uid(), polygon: poly, name, usage, areaM2: polyAreaM2(poly), occupants });
    };
    mk('走道', 'corridor', rect(0, 0, 41, 2));
    const names = ['101', '102', '103', '104', '105'];
    for (let i = 0; i < 5; i++) {
      mk(`${names[i]}室`, i === 2 ? 'storage' : 'office', rect(i * 8, 2, 8, 6), i === 2 ? 2 : 10);
      mk(`${names[i]}B室`, i === 0 ? 'retail' : 'office', rect(i * 8, -5, 8, 5), i === 0 ? 15 : 10);
    }
    const facilities: Facility[] = [];
    const dateStr = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
    const mkF = (kind: FacilityKind, x: number, y: number, code: string, checks: Facility['checks'] = [], spec?: Facility['spec']) => {
      facilities.push({ id: uid(), kind, x: x * M, y: y * M, code, checks, spec });
    };
    mkF('exit', 0.5, 1, '1F-EXIT-01');
    mkF('exit', 40.5, 1, '1F-EXIT-02');
    mkF('extinguisher', 20.5, 1, '1F-EX-01', [{ date: dateStr(20), status: 'ok' }], { extType: 'dry_powder', weightKg: 4 });
    mkF('extinguisher', 4, 5, '1F-EX-02', [{ date: dateStr(45), status: 'ok' }], { extType: 'dry_powder', weightKg: 4 });
    mkF('extinguisher', 36, 5, '1F-EX-03', [], { extType: 'co2', weightKg: 2 });
    mkF('hydrant', 10, 1, '1F-HY-01', [{ date: dateStr(10), status: 'ok' }]);
    mkF('exit_sign', 1, 1.7, '1F-ES-01', [{ date: dateStr(15), status: 'ok' }]);
    mkF('exit_sign', 40, 1.7, '1F-ES-02', [{ date: dateStr(15), status: 'ok' }]);
    mkF('emergency_light', 20.5, 0.4, '1F-EL-01', [{ date: dateStr(15), status: 'ok' }]);
    const exits = facilities.filter((f) => f.kind === 'exit').map((f) => f.id);
    const demoSnap: FloorSnapshot = { rooms, facilities, exits };
    s.floors[floorId] = {
      id: floorId,
      buildingId,
      level: 1,
      scaleMmPerUnit: 1,
      rooms,
      facilities,
      exits,
      version: 0,
      history: [
        {
          seq: 1,
          createdAt: new Date().toISOString(),
          summary: '初始版本（示例）',
          changes: [],
          origin: 'edit',
          snapshot: structuredClone(demoSnap),
          metrics: floorMetrics(demoSnap),
          validation: null,
        },
      ],
      historySeq: 1,
    };
  });
  persist();
  return bid;
}
