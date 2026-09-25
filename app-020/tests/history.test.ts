/**
 * 楼层平面版本对照验收用例：
 * - 每次图面改动落一版，摘要写清改了什么；
 * - 两版 diff：挪墙（改形）/平移（同形）/加删房间/换出口；
 * - 指标：面积、房间数、出口数、走道长度；
 * - 合规翻转：同一条规则合格↔不合规，两版限值各自冻结（规则可能改过）；
 * - 回退一键完成且自身记一版，历史不删除，检查记录保留。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getState,
  addBuilding,
  deleteBuilding,
  addFloor,
  addRoom,
  updateRoom,
  moveRoom,
  addFacility,
  moveFacility,
  addCheck,
  rollbackFloor,
  setLastValidation,
} from '../src/store/store';
import { validateFloor } from '../src/lib/engine';
import { DEFAULT_RULES } from '../src/rules/defaults';
import {
  corridorLengthM,
  diffCompliance,
  diffPlans,
  floorMetrics,
  namesOf,
  summarizeChanges,
} from '../src/lib/history';
import type { FloorSnapshot } from '../src/model';
import type { Pt } from '../src/model';

const M = 1000;
const rect = (x: number, y: number, w: number, h: number): Pt[] => [
  { x: x * M, y: y * M },
  { x: (x + w) * M, y: y * M },
  { x: (x + w) * M, y: (y + h) * M },
  { x: x * M, y: (y + h) * M },
];

let bid = '';
let fid = '';
const floorSnap = () => {
  const f = getState().floors[fid];
  return { rooms: f.rooms, facilities: f.facilities, exits: f.exits };
};
const revCount = () => getState().floors[fid].history!.length;
const lastRev = () => {
  const h = getState().floors[fid].history!;
  return h[h.length - 1];
};

beforeEach(() => {
  for (const b of [...getState().buildings]) deleteBuilding(b.id);
  bid = addBuilding('测试楼', 'office');
  fid = addFloor(bid, 1);
});

describe('走道长度指标（栅格图直径）', () => {
  it('H1 41m×2m 直走道 ≈ 41m', () => {
    const snap: FloorSnapshot = {
      rooms: [{ id: 'c', polygon: rect(0, 0, 41, 2), name: '走道', usage: 'corridor', areaM2: 82 }],
      facilities: [],
      exits: [],
    };
    const len = corridorLengthM(snap);
    expect(len).not.toBeNull();
    expect(len!).toBeGreaterThan(40.5);
    expect(len!).toBeLessThan(42);
  });

  it('H2 L 形走道直径沿路径（不走对角穿墙）', () => {
    // L：横 30m + 竖 20m，宽 2m，两端点路径长 ≈ 30 + 20 − 2 ≈ 48m
    const lpoly: Pt[] = [
      { x: 0, y: 0 }, { x: 30000, y: 0 }, { x: 30000, y: 2000 },
      { x: 2000, y: 2000 }, { x: 2000, y: 20000 }, { x: 0, y: 20000 },
    ];
    const len = corridorLengthM({
      rooms: [{ id: 'c', polygon: lpoly, name: 'L走道', usage: 'corridor', areaM2: 0 }],
    });
    expect(len).not.toBeNull();
    expect(len!).toBeGreaterThan(46);
    expect(len!).toBeLessThan(50);
    // 直线距离只有 ~34.5m，若切角穿墙会明显偏小
    expect(len!).toBeGreaterThan(40);
  });

  it('H3 无走道 → null', () => {
    expect(corridorLengthM({ rooms: [] })).toBeNull();
  });
});

describe('指标合计', () => {
  it('H4 面积/房间数/出口数', () => {
    const snap: FloorSnapshot = {
      rooms: [
        { id: '1', polygon: rect(0, 0, 8, 6), name: 'a', usage: 'office', areaM2: 48 },
        { id: '2', polygon: rect(0, 0, 10, 2), name: 'c', usage: 'corridor', areaM2: 20 },
      ],
      facilities: [
        { id: 'e1', kind: 'exit', x: 0, y: 0, code: '1F-EXIT-01', checks: [] },
        { id: 'x1', kind: 'extinguisher', x: 5000, y: 1000, code: '1F-EX-01', checks: [] },
      ],
      exits: ['e1'],
    };
    const m = floorMetrics(snap);
    expect(m.areaM2).toBeCloseTo(68, 5);
    expect(m.roomCount).toBe(2);
    expect(m.exitCount).toBe(1);
    expect(m.corridorLengthM).toBeGreaterThan(9);
  });
});

describe('图面 diff（挪墙 / 平移 / 增删 / 换出口）', () => {
  it('H5 同形整体平移 → room_moved，不是挪墙', () => {
    const a: FloorSnapshot = {
      rooms: [{ id: 'r', polygon: rect(0, 0, 8, 6), name: '101', usage: 'office', areaM2: 48 }],
      facilities: [], exits: [],
    };
    const b: FloorSnapshot = {
      rooms: [{ id: 'r', polygon: rect(1, 2, 8, 6), name: '101', usage: 'office', areaM2: 48 }],
      facilities: [], exits: [],
    };
    const d = diffPlans(a, b);
    expect(d.changes.map((c) => c.kind)).toEqual(['room_moved']);
    expect(d.changedRooms.has('r')).toBe(true);
  });

  it('H6 顶点相对位置变了 → room_reshaped（挪墙）', () => {
    const moved = [
      { x: 0, y: 0 }, { x: 9000, y: 0 }, { x: 9000, y: 6000 }, { x: 0, y: 6000 },
    ];
    const a: FloorSnapshot = {
      rooms: [{ id: 'r', polygon: rect(0, 0, 8, 6), name: '101', usage: 'office', areaM2: 48 }],
      facilities: [], exits: [],
    };
    const b: FloorSnapshot = {
      rooms: [{ id: 'r', polygon: moved, name: '101', usage: 'office', areaM2: 54 }],
      facilities: [], exits: [],
    };
    const d = diffPlans(a, b);
    expect(d.changes.map((c) => c.kind)).toEqual(['room_reshaped']);
  });

  it('H7 加房间 / 删房间 / 加出口 / 删出口', () => {
    const a: FloorSnapshot = {
      rooms: [{ id: 'r1', polygon: rect(0, 0, 8, 6), name: 'a', usage: 'office', areaM2: 48 }],
      facilities: [{ id: 'e1', kind: 'exit', x: 0, y: 0, code: 'E1', checks: [] }],
      exits: ['e1'],
    };
    const b: FloorSnapshot = {
      rooms: [
        { id: 'r1', polygon: rect(0, 0, 8, 6), name: 'a', usage: 'office', areaM2: 48 },
        { id: 'r2', polygon: rect(8, 0, 4, 4), name: 'b', usage: 'office', areaM2: 16 },
      ],
      facilities: [],
      exits: [],
    };
    const d = diffPlans(a, b);
    expect(d.changes.some((c) => c.kind === 'room_added' && c.entityId === 'r2')).toBe(true);
    expect(d.changes.some((c) => c.kind === 'exit_removed' && c.entityId === 'e1')).toBe(true);
    expect(d.addedRooms.has('r2')).toBe(true);
    expect(d.removedFacilities.has('e1')).toBe(true);
    // 摘要可读出改了什么
    expect(summarizeChanges(d.changes)).toContain('新增房间 ×1');
    expect(summarizeChanges(d.changes)).toContain('拆除安全出口 ×1');
  });

  it('H8 非几何属性变化按用途/人数/改名识别，且几何优先', () => {
    const poly = rect(0, 0, 8, 6);
    const a: FloorSnapshot = {
      rooms: [{ id: 'r', polygon: poly, name: '101', usage: 'office', areaM2: 48, occupants: 5 }],
      facilities: [], exits: [],
    };
    const bUsage: FloorSnapshot = {
      rooms: [{ id: 'r', polygon: poly, name: '101', usage: 'storage', areaM2: 48, occupants: 5 }],
      facilities: [], exits: [],
    };
    expect(diffPlans(a, bUsage).changes[0].kind).toBe('room_reusage');
    const bOcc: FloorSnapshot = {
      rooms: [{ id: 'r', polygon: poly, name: '101', usage: 'office', areaM2: 48, occupants: 9 }],
      facilities: [], exits: [],
    };
    expect(diffPlans(a, bOcc).changes[0].kind).toBe('room_occupants');
    const bName: FloorSnapshot = {
      rooms: [{ id: 'r', polygon: poly, name: '102', usage: 'office', areaM2: 48, occupants: 5 }],
      facilities: [], exits: [],
    };
    expect(diffPlans(a, bName).changes[0].kind).toBe('room_renamed');
  });

  it('H9 无变化 → 空 diff', () => {
    const s = floorSnap();
    const d = diffPlans(s, structuredClone(s));
    expect(d.changes).toHaveLength(0);
  });
});

describe('store：每次改动落版', () => {
  it('H10 新楼层自带初始版本', () => {
    const f = getState().floors[fid];
    expect(f.history).toHaveLength(1);
    expect(f.history![0].seq).toBe(1);
    expect(f.historySeq).toBe(1);
  });

  it('H11 加房间/挪房间/加出口各落一版，摘要与指标递增', () => {
    addRoom(fid, rect(0, 0, 41, 2), '走道', 'corridor');
    expect(revCount()).toBe(2);
    let rev = lastRev();
    expect(rev.summary).toContain('新增房间');
    expect(rev.metrics.roomCount).toBe(1);

    const rid = addRoom(fid, rect(0, 2, 8, 6), '101室', 'office');
    expect(revCount()).toBe(3);
    addFacility(fid, 'exit', 500, 1000);
    expect(revCount()).toBe(4);
    rev = lastRev();
    expect(rev.summary).toContain('新增安全出口');
    expect(rev.metrics.exitCount).toBe(1);

    moveRoom(fid, rid, 1000, 0);
    expect(revCount()).toBe(5);
    rev = lastRev();
    expect(rev.changes[0].kind).toBe('room_moved');
  });

  it('H12 拖动到原位（零位移）不落版', () => {
    addRoom(fid, rect(0, 0, 8, 6), 'r', 'office');
    const n = revCount();
    moveRoom(fid, getState().floors[fid].rooms[0].id, 0, 0);
    expect(revCount()).toBe(n);
  });

  it('H13 检查记录/设施规格不产生新版本（非图面改动）', () => {
    const xid = addFacility(fid, 'extinguisher', 5000, 1000);
    const n = revCount();
    addCheck(fid, xid, { date: '2026-09-01', status: 'ok' });
    expect(revCount()).toBe(n);
    expect(getState().floors[fid].facilities.find((f) => f.id === xid)!.checks).toHaveLength(1);
  });

  it('H13b 连续属性输入防抖合并成一版；几何改动先把属性冲掉再单独成版', () => {
    vi.useFakeTimers();
    try {
      const rid = addRoom(fid, rect(0, 0, 8, 6), 'r', 'office');
      const afterAdd = revCount();

      // 模拟逐字输入「101室」：每次按键都同步到平面，但不落版
      updateRoom(fid, rid, { name: '1' });
      updateRoom(fid, rid, { name: '10' });
      updateRoom(fid, rid, { name: '101' });
      expect(getState().floors[fid].rooms[0].name).toBe('101'); // 输入即时响应
      expect(revCount()).toBe(afterAdd); // 防抖期内尚未落版

      vi.advanceTimersByTime(400);
      expect(revCount()).toBe(afterAdd + 1); // 停顿后合并为一版
      expect(lastRev().changes.map((c) => c.kind)).toEqual(['room_renamed']);

      // 几何改动到来时，挂起的属性先冲掉，几何再单独成版
      updateRoom(fid, rid, { name: '102' }); // 又开始一轮输入
      expect(revCount()).toBe(afterAdd + 1);
      moveRoom(fid, rid, 1000, 0); // 拖动 → 立即冲掉属性并落几何版
      expect(revCount()).toBe(afterAdd + 3); // 属性版 + 几何版
      const kinds = getState().floors[fid].history!.slice(-2).map((r) => r.changes[0]?.kind);
      expect(kinds).toEqual(['room_renamed', 'room_moved']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('H14 setLastValidation 只回写当前版；旧版冻结结论不被污染', () => {
    addRoom(fid, rect(0, 0, 21, 2), '走道', 'corridor');
    addFacility(fid, 'extinguisher', 10500, 1000);
    addFacility(fid, 'exit', 20500, 1000);
    const f1 = getState().floors[fid];
    const r1 = validateFloor(f1, DEFAULT_RULES.office); // 办公限值 22m：死端合格
    setLastValidation(fid, r1);
    const afterFirst = getState().floors[fid].history!;
    expect(afterFirst[afterFirst.length - 1].validation?.pass).toBe(true);

    // 改规则后触发的重校验（模拟编辑器在规则变更后重算当前版）
    const tightened = { ...DEFAULT_RULES.office, deadEndDistanceM: 10, version: 9 };
    const f2 = getState().floors[fid];
    const r2 = validateFloor(f2, tightened);
    setLastValidation(fid, r2);
    const hist = getState().floors[fid].history!;
    // 当前版更新为不合规
    expect(hist[hist.length - 1].validation?.pass).toBe(false);
    // 初始空版仍为 null（不被乱写）
    expect(hist[0].validation).toBeNull();
  });
});

describe('一键回退', () => {
  it('H15 回退恢复几何、自身记一版、历史不删、检查记录保留', () => {
    addRoom(fid, rect(0, 0, 8, 6), '101', 'office'); // v2：1 个房间
    const v2 = revCount();
    const xid = addFacility(fid, 'extinguisher', 4000, 3000); // v3：加了灭火器
    addCheck(fid, xid, { date: '2026-09-01', status: 'ok' });
    addRoom(fid, rect(8, 0, 6, 6), '102', 'office'); // v4：2 个房间
    expect(revCount()).toBe(v2 + 2);
    expect(getState().floors[fid].rooms).toHaveLength(2);

    const ok = rollbackFloor(fid, 2);
    expect(ok).toBe(true);
    const f = getState().floors[fid];
    expect(f.rooms).toHaveLength(1); // 几何恢复
    expect(f.rooms[0].name).toBe('101');
    expect(f.facilities.some((x) => x.id === xid)).toBe(false); // v2 时无此灭火器
    expect(revCount()).toBe(v2 + 3); // 回退自身一版，历史一条没少
    const rollbackRev = f.history![getState().floors[fid].history!.length - 1];
    expect(rollbackRev.origin).toBe('rollback');
    expect(rollbackRev.restoredSeq).toBe(2);
    expect(rollbackRev.rolledBackFrom).toBe(4);
    expect(rollbackRev.summary).toContain('回退到 v2');
    // 回退版与被恢复版指标一致
    expect(rollbackRev.metrics.roomCount).toBe(1);
    const v2rev = f.history!.find((r) => r.seq === 2)!;
    expect(v2rev).toBeDefined(); // 旧版仍在
  });

  it('H16 回退后新增的检查记录：恢复的设施带着原台账（回退不丢检查）', () => {
    const eid = addFacility(fid, 'exit', 500, 500); // v2
    addCheck(fid, eid, { date: '2026-08-01', status: 'ok' });
    moveFacility(fid, eid, 9000, 9000); // v3 挪了出口
    expect(getState().floors[fid].facilities[0].x).toBe(9000);
    rollbackFloor(fid, 2);
    const f = getState().floors[fid];
    const e = f.facilities.find((x) => x.id === eid)!;
    expect(e.x).toBe(500); // 几何回退
    expect(e.checks).toHaveLength(1); // 台账保留
    expect(e.checks[0].date).toBe('2026-08-01');
  });
});

describe('合规结论翻转对照', () => {
  /** 造一条单走道楼层（测试引擎入参），出口按给定 x（m）布置；中间放一个灭火器避免覆盖项干扰结论 */
  function mkEngineFloor(len: number, exitXs: number[]) {
    const facilities = [
      ...exitXs.map((x, i) => ({
        id: `e${i}`, kind: 'exit' as const, x: x * M, y: 1000, code: `E${i}`, checks: [],
      })),
      { id: 'x0', kind: 'extinguisher' as const, x: (len / 2) * M, y: 1000, code: 'X0', checks: [] },
    ];
    return {
      id: fid, buildingId: bid, level: 1, scaleMmPerUnit: 1,
      rooms: [{ id: 'c', polygon: rect(0, 0, len, 2), name: '走道', usage: 'corridor' as const, areaM2: len * 2 }],
      facilities,
      exits: exitXs.map((_, i) => `e${i}`),
      version: 0,
    };
  }
  const snapOf = (fl: ReturnType<typeof mkEngineFloor>): FloorSnapshot => ({
    rooms: fl.rooms, facilities: fl.facilities, exits: fl.exits,
  });

  it('H17 同一图纸：收紧死端限值 22→10，DEADEND 合格→不合规，两版限值各自带出', () => {
    const fl = mkEngineFloor(21, [20.5]);
    const oldV = validateFloor(fl, DEFAULT_RULES.office); // 22m 限值 → 合格
    expect(oldV.pass).toBe(true);
    const tight = { ...DEFAULT_RULES.office, deadEndDistanceM: 10, version: 5, source: '内部加严通知-2026' };
    const newV = validateFloor(fl, tight); // 10m 限值 → 不合规
    expect(newV.pass).toBe(false);

    const d = diffCompliance(oldV, newV, namesOf(snapOf(fl)));
    expect(d.oldPass).toBe(true);
    expect(d.newPass).toBe(false);
    const flip = d.flips.find((f) => f.type === 'DEADEND_EXCEED')!;
    expect(flip).toBeDefined();
    expect(flip.direction).toBe('pass_to_fail');
    expect(flip.oldLimit).toBe(22);
    expect(flip.newLimit).toBe(10);
    expect(flip.oldRuleVersion).toBe(1);
    expect(flip.newRuleVersion).toBe(5);
    expect(flip.newRuleSource).toContain('加严');
  });

  it('H18 加长走道使死端超限（规则未变）：方向 pass_to_fail，两版限值相同', () => {
    const oldV = validateFloor(mkEngineFloor(15, [0.5]), DEFAULT_RULES.office);
    const fl = mkEngineFloor(40, [0.5]);
    const newV = validateFloor(fl, DEFAULT_RULES.office);
    const d = diffCompliance(oldV, newV, namesOf(snapOf(fl)));
    const flip = d.flips.find((f) => f.type === 'DEADEND_EXCEED')!;
    expect(flip.direction).toBe('pass_to_fail');
    expect(flip.oldLimit).toBe(flip.newLimit);
    expect(flip.oldLimit).toBe(22);
  });

  it('H19 两版都不合规不算翻转；另一端补出口后 fail_to_pass', () => {
    const bad = mkEngineFloor(40, [0.5]); // 单出口：死端与疏散距离均不合格
    const vBad = validateFloor(bad, DEFAULT_RULES.office);
    expect(vBad.pass).toBe(false);
    expect(diffCompliance(vBad, vBad, namesOf(snapOf(bad))).flips).toHaveLength(0);

    const good = mkEngineFloor(40, [0.5, 39.5]); // 两端出口 → 死端消失
    const vGood = validateFloor(good, DEFAULT_RULES.office);
    const d = diffCompliance(vBad, vGood, namesOf(snapOf(good)));
    const de = d.flips.find((f) => f.type === 'DEADEND_EXCEED')!;
    expect(de.direction).toBe('fail_to_pass');
    expect(de.oldValue).toBeGreaterThan(22);
    expect(de.oldLimit).toBe(22);
  });

  it('H20 未校验版本：pass=null 且不产生翻转', () => {
    const d = diffCompliance(null, null, namesOf({ rooms: [], facilities: [], exits: [] }));
    expect(d.oldPass).toBeNull();
    expect(d.newPass).toBeNull();
    expect(d.flips).toHaveLength(0);
  });
});
