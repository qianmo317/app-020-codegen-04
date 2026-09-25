import { useSyncExternalStore } from 'react';
import type {
  Building,
  BuildingKind,
  CheckRecord,
  Facility,
  FacilityKind,
  Floor,
  FloorRevision,
  PlanChange,
  PlanSnapshot,
  Pt,
  Room,
  RoomUsage,
  RuleSet,
  ValidationResult,
} from '../model';
import { DEFAULT_RULES } from '../rules/defaults';
import { nextCode, uid } from './id';
import { polyAreaM2 } from '../lib/geometry';
import { validateFloor } from '../lib/engine';
import { computeMetrics, diffPlans, snapshotEqual, summarizeChanges, takeSnapshot } from '../lib/history';

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

/** 修改楼层并替换其引用 —— 保证 useStore(s => s.floors[id]) 的订阅者能感知更新 */
function updateFloor(floorId: string, mut: (f: Floor) => void) {
  setState((s) => {
    const f = s.floors[floorId];
    if (!f) return;
    mut(f);
    s.floors[floorId] = { ...f };
  });
}

// ---------- 版本历史 ----------

/** 同一属性编辑在此窗口内连续发生则并入同一版（避免输入框每次击键产生一版历史） */
const REVISION_COALESCE_MS = 10_000;

function rulesForFloor(s: AppState, f: Floor): RuleSet {
  const kind = s.buildings.find((b) => b.id === f.buildingId)?.kind ?? 'office';
  return s.rules[kind] ?? DEFAULT_RULES.office;
}

/** 建版（不追加到历史，仅构造对象） */
function buildRevision(
  floor: Floor,
  rules: RuleSet,
  kind: FloorRevision['kind'],
  summary: string,
  changes: FloorRevision['changes'],
  snapshot: PlanSnapshot,
  extra?: Partial<FloorRevision>,
): FloorRevision {
  const revisions = floor.revisions ?? [];
  const seq = revisions.reduce((m, r) => Math.max(m, r.seq), 0) + 1;
  return {
    id: uid(),
    seq,
    kind,
    createdAt: new Date().toISOString(),
    summary,
    changes,
    snapshot,
    metrics: computeMetrics(snapshot),
    rules: structuredClone(rules),
    validation: floor.lastValidation ? structuredClone(floor.lastValidation) : null,
    ...extra,
  };
}

/** 为尚无历史的楼层补建「初始版」（新建楼层 / 旧数据首次编辑前都会走到） */
function seedBaseline(s: AppState, f: Floor) {
  if (f.revisions && f.revisions.length) return;
  const rules = rulesForFloor(s, f);
  const hasPlan = f.rooms.length > 0 || f.facilities.length > 0;
  f.lastValidation = hasPlan ? validateFloor(f, rules) : undefined;
  const rev = buildRevision(f, rules, 'baseline', '初始平面', [], takeSnapshot(f));
  f.revisions = [rev];
}

/**
 * 平面编辑的统一入口：
 * 1) 首次编辑前补建初始版（旧数据也能对照）；
 * 2) 执行变更，比较前后快照，无实际平面差异则不建版；
 * 3) coalesceKey 相同且在合并窗口内的连续属性编辑并入上一版；
 * 4) 否则追加 edit 版，写清改了什么。
 */
function mutatePlan(floorId: string, mut: (f: Floor) => void, coalesceKey?: string) {
  setState((s) => {
    const f = s.floors[floorId];
    if (!f) return;
    seedBaseline(s, f);
    const before = takeSnapshot(f);
    mut(f);
    // takeSnapshot 已深拷贝，存入历史的快照与 live 状态不共享对象
    const after = takeSnapshot(f);
    if (snapshotEqual(before, after)) return;
    const diff = diffPlans(before, after);
    if (!diff.changes.length) return;
    const rules = rulesForFloor(s, f);
    const revs = f.revisions!;
    const head = revs[revs.length - 1];
    const nowMs = Date.now();
    const canCoalesce =
      coalesceKey != null &&
      head.kind === 'edit' &&
      nowMs - new Date(head.createdAt).getTime() <= REVISION_COALESCE_MS &&
      // 头部 edit 版要么还没有合并键（刚画完图元立刻改属性），要么键相同
      (head.coalesceKey === undefined || head.coalesceKey === coalesceKey);
    if (canCoalesce) {
      // 并入：以主体 id 归并增量变更到头部版本：
      //  - 头部已有该主体的「新增」，本次又是「删除」→ 完全抵消（条目移除）
      //  - 头部已有「删除」，本次又是「新增」（同 id 复活一般不出现）→ 按移动/修改处理
      //  - 同类条目（连续改名）→ 用最新值替换
      //  - 其余 → 追加
      const LIFECYCLE: ReadonlySet<PlanChange['kind']> = new Set([
        'room_added', 'room_removed', 'exit_added', 'exit_removed', 'facility_added', 'facility_removed',
      ]);
      const mergedChanges = [...head.changes];
      for (const c of diff.changes) {
        const subjectIdx = mergedChanges.findIndex((x) => x.subjectId === c.subjectId);
        const sameIdx = mergedChanges.findIndex((x) => x.subjectId === c.subjectId && x.kind === c.kind);
        const subj = subjectIdx >= 0 ? mergedChanges[subjectIdx] : undefined;
        const lifecycleCancel =
          subj &&
          LIFECYCLE.has(subj.kind) &&
          LIFECYCLE.has(c.kind) &&
          ((subj.kind.endsWith('_added') && c.kind.endsWith('_removed')) ||
            (subj.kind.endsWith('_removed') && c.kind.endsWith('_added')));
        if (lifecycleCancel) {
          mergedChanges.splice(subjectIdx, 1); // 新增后又删 = 抵消
        } else if (sameIdx >= 0) {
          mergedChanges[sameIdx] = c; // 同主体同类型（连续改名/移动）→ 新值替换
        } else {
          mergedChanges.push(c); // 新类型变更（新增后又改名）→ 并存
        }
      }
      const merged: FloorRevision = {
        ...head,
        snapshot: after,
        metrics: computeMetrics(after),
        changes: mergedChanges,
        summary: summarizeChanges(mergedChanges),
        createdAt: new Date(nowMs).toISOString(),
        coalesceKey: head.coalesceKey ?? coalesceKey, // 已并入后固定用头部首键
      };
      f.revisions = [...revs.slice(0, -1), merged];
      s.floors[floorId] = { ...f, revisions: f.revisions };
      return;
    }
    revs.push(
      buildRevision(f, rules, 'edit', summarizeChanges(diff.changes), diff.changes, after, {
        coalesceKey,
      }),
    );
    s.floors[floorId] = { ...f, revisions: [...revs] };
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
    for (const fid of b.floors) delete s.floors[fid];
    s.buildings = s.buildings.filter((x) => x.id !== id);
  });
}

// ---------- 楼层 ----------

export function addFloor(buildingId: string, level: number): string {
  const id = uid();
  const floor: Floor = {
    id,
    buildingId,
    level,
    scaleMmPerUnit: 1,
    rooms: [],
    facilities: [],
    exits: [],
    version: 0,
    revisions: [],
  };
  setState((s) => {
    s.floors[id] = floor;
    // 空楼层也建一版「初始平面」，首次画图即与它对照
    seedBaseline(s, floor);
    s.floors[id] = { ...floor, revisions: [...floor.revisions!] };
    const bi = s.buildings.findIndex((x) => x.id === buildingId);
    if (bi >= 0) s.buildings[bi] = { ...s.buildings[bi], floors: [...s.buildings[bi].floors, id] };
  });
  return id;
}

export function deleteFloor(floorId: string) {
  setState((s) => {
    const f = s.floors[floorId];
    if (!f) return;
    const bi = s.buildings.findIndex((x) => x.id === f.buildingId);
    if (bi >= 0) {
      s.buildings[bi] = { ...s.buildings[bi], floors: s.buildings[bi].floors.filter((x) => x !== floorId) };
    }
    delete s.floors[floorId];
    delete s.marks[floorId];
  });
}

// ---------- 房间 ----------

export function addRoom(floorId: string, polygon: Pt[], name: string, usage: RoomUsage): string {
  const id = uid();
  mutatePlan(floorId, (f) => {
    f.version++;
    f.rooms.push({ id, polygon, name, usage, areaM2: polyAreaM2(polygon) });
  });
  return id;
}

export function updateRoom(floorId: string, roomId: string, patch: Partial<Pick<Room, 'name' | 'usage' | 'occupants'>>) {
  // 属性编辑的合并键只按主体（房间 id），不按字段：
  // 画完房间立刻改名、改名后又改用途，都应与「新增房间」同属一版
  const key = `room:${roomId}`;
  mutatePlan(floorId, (f) => {
    const r = f.rooms.find((x) => x.id === roomId);
    if (r) {
      Object.assign(r, patch);
      f.version++;
    }
  }, key);
}

export function deleteRoom(floorId: string, roomId: string) {
  mutatePlan(floorId, (f) => {
    f.version++;
    f.rooms = f.rooms.filter((x) => x.id !== roomId);
  });
}

/** 拖动整体平移房间多边形（保留 id、人数等属性与数组顺序） */
export function moveRoom(floorId: string, roomId: string, dx: number, dy: number) {
  mutatePlan(floorId, (f) => {
    const r = f.rooms.find((x) => x.id === roomId);
    if (!r) return;
    r.polygon = r.polygon.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    f.version++;
  });
}

// ---------- 设施 ----------

export function addFacility(floorId: string, kind: FacilityKind, x: number, y: number): string {
  const id = uid();
  mutatePlan(floorId, (f) => {
    const fac: Facility = { id, kind, x, y, code: nextCode(f, kind), checks: [] };
    if (kind === 'extinguisher') fac.spec = { extType: 'dry_powder', weightKg: 4 };
    f.version++;
    f.facilities.push(fac);
    if (kind === 'exit') f.exits.push(id);
  });
  return id;
}

export function moveFacility(floorId: string, facilityId: string, x: number, y: number) {
  mutatePlan(floorId, (f) => {
    const fac = f.facilities.find((x2) => x2.id === facilityId);
    if (fac) {
      fac.x = x;
      fac.y = y;
      f.version++;
    }
  });
}

export function updateFacility(floorId: string, facilityId: string, patch: Partial<Pick<Facility, 'spec'>>) {
  // 规格（灭火器类型/重量）不影响平面几何与合规结论，不建版，保留原 updateFloor 语义
  updateFloor(floorId, (f) => {
    const fac = f.facilities.find((x) => x.id === facilityId);
    if (fac && patch.spec) {
      fac.spec = patch.spec;
      f.version++;
    }
  });
}

export function deleteFacility(floorId: string, facilityId: string) {
  mutatePlan(floorId, (f) => {
    f.version++;
    f.facilities = f.facilities.filter((x) => x.id !== facilityId);
    f.exits = f.exits.filter((x) => x !== facilityId);
  });
}

export function addCheck(floorId: string, facilityId: string, check: CheckRecord) {
  updateFloor(floorId, (f) => {
    const fac = f.facilities.find((x) => x.id === facilityId);
    if (fac) {
      fac.checks.push(check);
      f.version++;
    }
  });
}

export function deleteCheck(floorId: string, facilityId: string, index: number) {
  updateFloor(floorId, (f) => {
    const fac = f.facilities.find((x) => x.id === facilityId);
    if (fac) {
      fac.checks.splice(index, 1);
      f.version++;
    }
  });
}

// ---------- 底图 / 标记 / 校验结果 ----------

export function setUnderlay(floorId: string, underlay: Floor['underlay']) {
  updateFloor(floorId, (f) => {
    f.underlay = underlay;
  });
}

export function setMark(floorId: string, pt: Pt) {
  setState((s) => {
    s.marks[floorId] = { ...pt };
  });
}

export function setLastValidation(floorId: string, result: ValidationResult) {
  updateFloor(floorId, (f) => {
    f.lastValidation = result;
    // 回填最新一版：自动校验在编辑后异步完成，建版时拿到的还是旧结果。
    // 只回填最新版——历史版本的合规结论必须定格在建版当时，不能被新规则覆盖。
    if (f.revisions && f.revisions.length) {
      const revs = f.revisions;
      const head = revs[revs.length - 1];
      head.validation = structuredClone(result);
      f.revisions = [...revs.slice(0, -1), { ...head }];
    }
  });
}

// ---------- 回退 ----------

/**
 * 一键回退到指定历史版本：用该版快照覆盖当前平面，自身再追加一版 rollback。
 * 历史一条不删——回退版里写明来源版本号；检查台账（checks）保留当前数据，
 * 已删除又随回退恢复的设施沿用其旧编号、台账为空。
 */
export function restoreRevision(floorId: string, revisionId: string) {
  setState((s) => {
    const f = s.floors[floorId];
    if (!f || !f.revisions) return;
    const target = f.revisions.find((r) => r.id === revisionId);
    if (!target) return;
    seedBaseline(s, f);
    const before = takeSnapshot(f);
    const snap = structuredClone(target.snapshot);
    // 检查台账合并：现存设施保留当前台账（新检查不能丢）；随回退恢复的设施沿用快照里的历史台账
    const currentChecks = new Map(f.facilities.map((x) => [x.id, x.checks]));
    // 注意：snap 已是独立深拷贝，赋给当前楼层不会让 live 状态与历史快照共享对象
    f.rooms = snap.rooms;
    f.facilities = snap.facilities.map((x) => ({
      ...x,
      checks: currentChecks.has(x.id) ? structuredClone(currentChecks.get(x.id)!) : x.checks ?? [],
    }));
    f.exits = [...snap.exits];
    f.version++;
    const after = takeSnapshot(f);
    if (snapshotEqual(before, after)) return;
    // 回退即时校验：用当前规则（限值可能已与目标版不同，差异在对照页可见）
    const rules = rulesForFloor(s, f);
    f.lastValidation = validateFloor(f, rules);
    const diff = diffPlans(before, after);
    const rev = buildRevision(
      f,
      rules,
      'rollback',
      `回退到 v${target.seq}`,
      diff.changes,
      after,
      { rollbackFromSeq: target.seq },
    );
    rev.validation = structuredClone(f.lastValidation);
    f.revisions = [...f.revisions!, rev];
    s.floors[floorId] = { ...f };
  });
}

/** 取楼层版本历史（旧序→新序）；无历史的旧数据返回空数组 */
export function listRevisions(floorId: string): FloorRevision[] {
  return state.floors[floorId]?.revisions ?? [];
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
    const floor: Floor = {
      id: floorId,
      buildingId,
      level: 1,
      scaleMmPerUnit: 1,
      rooms,
      facilities,
      exits,
      version: 0,
      revisions: [],
    };
    s.floors[floorId] = floor;
    // 建版并跑一次初始校验（办公楼规则下示例平面全过）
    seedBaseline(s, floor);
    s.floors[floorId] = { ...floor, revisions: [...floor.revisions!] };
  });
  persist();
  return bid;
}
