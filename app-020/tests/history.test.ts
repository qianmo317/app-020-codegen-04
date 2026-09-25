/**
 * 版本历史核心逻辑：指标、图元差异、改动明细、合规结论翻转。
 */
import { describe, it, expect } from 'vitest';
import type { Floor, Facility, PlanSnapshot, ValidationItem, ValidationResult } from '../src/model';
import { DEFAULT_RULES } from '../src/rules/defaults';
import {
  computeMetrics,
  corridorCenterlineM,
  diffCompliance,
  diffPlans,
  floorFromSnapshot,
  gridSkeletonMm,
  snapshotEqual,
  summarizeChanges,
  takeSnapshot,
} from '../src/lib/history';
import { mkRoom, rect, mkFloor, M } from './helpers';
import type { FacSpec } from './helpers';

function snapOf(rooms: ReturnType<typeof mkRoom>[], facs: FacSpec[] = []): PlanSnapshot {
  const { floor } = mkFloor(rooms, facs);
  return takeSnapshot(floor);
}

describe('走道中心线长度（栅格骨架）', () => {
  it('H1 41m 直走道 ≈ 41m（±1m，含栅格截断误差）', () => {
    const L = corridorCenterlineM([rect(0, 0, 41, 2)]);
    expect(L).toBeGreaterThan(40);
    expect(L).toBeLessThan(42);
  });

  it('H2 L 形走道取折线长度而非周长/外接框', () => {
    // 横 30m + 竖 20m，搭接 2m → 中心线约 48m；周长法会给 ~100m，外接框法给 ~50m 直线
    const lshape: { x: number; y: number }[][] = [[
      { x: 0, y: 0 }, { x: 30 * M, y: 0 }, { x: 30 * M, y: 2 * M },
      { x: 2 * M, y: 2 * M }, { x: 2 * M, y: 20 * M }, { x: 0, y: 20 * M },
    ]];
    const L = corridorCenterlineM(lshape);
    expect(L).toBeGreaterThan(44);
    expect(L).toBeLessThan(52);
  });

  it('H3 无走道时长度为 0', () => {
    expect(corridorCenterlineM([])).toBe(0);
  });

  it('H3b 丁字口：横走道长度 + 袋形竖枝，分支不丢也不重复计', () => {
    const polys: { x: number; y: number }[][] = [
      [{ x: 0, y: 10 * M }, { x: 40 * M, y: 10 * M }, { x: 40 * M, y: 12 * M }, { x: 0, y: 12 * M }],
      [{ x: 19 * M, y: 2 * M }, { x: 21 * M, y: 2 * M }, { x: 21 * M, y: 11 * M }, { x: 19 * M, y: 11 * M }],
    ];
    const L = corridorCenterlineM(polys);
    // 40m 横 + 从中线向上约 8m 袋形 = 48m ± 2m
    expect(L).toBeGreaterThan(46);
    expect(L).toBeLessThan(50.5);
  });

  it('H4 gridSkeletonMm：边权和含端点半径补偿，直条 = 边长 + 2×半宽', () => {
    // 11 格水平条：10 条水平边 + 2 个端补偿（每端 4 格=1m）= 18 步
    let img = new Uint8Array(11 * 3);
    for (let i = 0; i < 11; i++) img[1 * 11 + i] = 1;
    expect(gridSkeletonMm(img, 11, 3, 250) / 250).toBeCloseTo(18, 5);

    // 环（首尾相接的方环，0 端点）不补端
    img = new Uint8Array(7 * 7);
    for (let i = 1; i <= 5; i++) {
      img[1 * 7 + i] = 1;
      img[5 * 7 + i] = 1;
      img[i * 7 + 1] = 1;
      img[i * 7 + 5] = 1;
    }
    const ring = gridSkeletonMm(img, 7, 7, 250) / 250;
    // 4 边各 4 条边 = 16（角点对角边不参与，正交连通）
    expect(ring).toBeGreaterThanOrEqual(16 - 0.01);
    expect(ring).toBeLessThanOrEqual(16 + 0.01);

    // 单格不产生长度
    img = new Uint8Array(3 * 3);
    img[4] = 1;
    expect(gridSkeletonMm(img, 3, 3, 250)).toBe(0);
  });
});

describe('指标汇总', () => {
  it('H5 面积/房间数（不含走道）/出口数/走道长度', () => {
    const s = snapOf(
      [
        mkRoom('走道', 'corridor', rect(0, 0, 20, 2)),
        mkRoom('101', 'office', rect(0, 2, 8, 6)),
        mkRoom('102', 'office', rect(8, 2, 12, 6)),
      ],
      [
        { kind: 'exit', x: 0.5, y: 1 },
        { kind: 'exit', x: 19.5, y: 1 },
        { kind: 'extinguisher', x: 10, y: 1 },
      ],
    );
    const m = computeMetrics(s);
    expect(m.areaM2).toBeCloseTo(40 + 48 + 72, 5); // 走道 40 + 两房间
    expect(m.roomCount).toBe(2);
    expect(m.exitCount).toBe(2);
    expect(m.corridorLengthM).toBeGreaterThan(19);
    expect(m.corridorLengthM).toBeLessThan(21);
  });
});

describe('图元差异与改动明细', () => {
  it('H6 加房间/删房间/加出口分别识别并生成中文条目', () => {
    const r1 = mkRoom('101', 'office', rect(0, 0, 8, 6));
    const r2 = mkRoom('102', 'office', rect(8, 0, 8, 6));
    const exit1 = { id: 'E1', kind: 'exit' as const, x: 0.5 * M, y: M, code: '1F-EXIT-01', checks: [] };
    const exit2 = { id: 'E2', kind: 'exit' as const, x: 15.5 * M, y: M, code: '1F-EXIT-02', checks: [] };
    const before: PlanSnapshot = { rooms: [r1], facilities: [exit1], exits: ['E1'] };
    const after: PlanSnapshot = { rooms: [r2], facilities: [exit1, exit2], exits: ['E1', 'E2'] };
    const d = diffPlans(before, after);
    expect(d.removedRoomIds).toEqual([r1.id]);
    expect(d.addedRoomIds).toEqual([r2.id]);
    expect(d.addedFacilityIds).toEqual(['E2']);
    const kinds = d.changes.map((c) => c.kind);
    expect(kinds).toContain('room_removed');
    expect(kinds).toContain('room_added');
    expect(kinds).toContain('exit_added');
    expect(d.changes.find((c) => c.kind === 'exit_added')?.detail).toContain('安全出口');
  });

  it('H7 同 id 房间整体平移 = 挪动；非平移顶点变化 = 调整墙体（含面积变化）', () => {
    const r = mkRoom('101', 'office', rect(0, 0, 8, 6));
    const moved = { ...r, polygon: r.polygon.map((p) => ({ x: p.x + 3 * M, y: p.y })) };
    const dMove = diffPlans(snapOf([r]), snapOf([moved]));
    expect(dMove.changedRoomIds).toEqual([r.id]);
    expect(dMove.changes[0].kind).toBe('room_moved');
    expect(dMove.changes[0].detail).toContain('3.0m');

    // 加宽墙：8m→10m，面积 48→60
    const reshaped = { ...r, polygon: rect(0, 0, 10, 6) };
    // 保持同 id
    reshaped.id = r.id;
    const dShape = diffPlans(snapOf([r]), snapOf([reshaped]));
    expect(dShape.changes[0].kind).toBe('room_reshaped');
    expect(dShape.changes[0].detail).toContain('+12.0㎡');
  });

  it('H8 改名/改用途/改人数分别成条', () => {
    const r = mkRoom('101', 'office', rect(0, 0, 8, 6), 10);
    const now = { ...r, name: '101会议室', usage: 'retail' as const, occupants: 20 };
    const d = diffPlans(snapOf([r]), snapOf([now]));
    const kinds = d.changes.map((c) => c.kind);
    expect(kinds).toEqual(expect.arrayContaining(['room_renamed', 'room_reused', 'room_occupants']));
    expect(d.changes.find((c) => c.kind === 'room_reused')?.detail).toContain('办公→商业');
  });

  it('H9 删除出口识别为 exit_removed，设施移动给距离', () => {
    const before = snapOf([], [
      { kind: 'exit', x: 1, y: 1 },
      { kind: 'extinguisher', x: 5, y: 5 },
    ]);
    const exitId = before.facilities.find((f) => f.kind === 'exit')!.id;
    const extId = before.facilities.find((f) => f.kind === 'extinguisher')!.id;
    const after: PlanSnapshot = {
      rooms: [],
      facilities: [
        { ...before.facilities.find((f) => f.id === extId)! as Facility, x: 9 * M, y: 5 * M },
      ],
      exits: [],
    };
    void exitId;
    const d = diffPlans(before, after);
    expect(d.removedFacilityIds).toEqual([exitId]);
    expect(d.changes.find((c) => c.kind === 'exit_removed')).toBeTruthy();
    const movedExt = d.changes.find((c) => c.kind === 'facility_moved');
    expect(movedExt?.detail).toContain('4.0m');
  });

  it('H10 快照相等只看平面形状：exits 数组冗余、检查台账差异均不影响', () => {
    const s1 = snapOf([mkRoom('r', 'office', rect(0, 0, 4, 4))], [{ kind: 'exit', x: 1, y: 1 }]);
    const s2: PlanSnapshot = {
      rooms: structuredClone(s1.rooms),
      facilities: s1.facilities.map((f) => ({ ...f, checks: [{ date: '2026-09-20', status: 'ok' }] })),
      exits: [], // 实际出口设施仍在，归一化后应视为相等
    };
    expect(snapshotEqual(s1, s2)).toBe(true);
    // 但设施移动必须算变化
    const s3: PlanSnapshot = {
      rooms: structuredClone(s1.rooms),
      facilities: s1.facilities.map((f) => ({ ...f, x: f.x + 500 })),
      exits: [],
    };
    expect(snapshotEqual(s1, s3)).toBe(false);
  });

  it('H11 汇总一句话包含动作与重复计数', () => {
    const before = snapOf([]);
    const after = snapOf([
      mkRoom('a', 'office', rect(0, 0, 4, 4)),
      mkRoom('b', 'office', rect(5, 0, 4, 4)),
    ]);
    expect(summarizeChanges(diffPlans(before, after).changes)).toContain('新增房间×2');
  });
});

describe('快照与可渲染楼层', () => {
  it('H12 takeSnapshot 深拷贝台账；floorFromSnapshot 可喂给 FloorPlan', () => {
    const { floor } = mkFloor([mkRoom('r', 'office', rect(0, 0, 4, 4))], [
      { kind: 'extinguisher', x: 1, y: 1, checks: [{ date: '2026-09-01', status: 'ok' }] },
    ]);
    const s = takeSnapshot(floor);
    expect(s.facilities[0].checks).toHaveLength(1);
    s.facilities[0].checks.push({ date: '2026-09-02', status: 'ok' });
    expect(floor.facilities[0].checks).toHaveLength(1); // 深拷贝隔离
    const f = floorFromSnapshot(s, 3);
    expect(f.level).toBe(3);
    expect(f.rooms).toHaveLength(1);
  });
});

// ---------- 合规翻转 ----------

function validation(items: ValidationItem[], pass: boolean, rulesVersion = 1): ValidationResult {
  return {
    checkedAt: new Date().toISOString(),
    pass,
    items,
    travelWorstM: null,
    travelWorstPoint: null,
    deadEndM: null,
    coverage: null,
    exits: { present: 1, required: 1 },
    rulesSnapshot: {
      buildingKind: 'office',
      version: rulesVersion,
      source: DEFAULT_RULES.office.source,
      maxTravelDistanceM: DEFAULT_RULES.office.maxTravelDistanceM,
      deadEndDistanceM: DEFAULT_RULES.office.deadEndDistanceM,
      extinguisherRadiusM: DEFAULT_RULES.office.extinguisherRadiusM,
      exitMinAreaM2: DEFAULT_RULES.office.exitMinAreaM2,
      exitMaxOccupants: DEFAULT_RULES.office.exitMaxOccupants,
    },
  };
}

describe('合规结论翻转', () => {
  const room = mkRoom('101', 'office', rect(0, 0, 10, 10));
  const snap = snapOf([room], [{ kind: 'exit', x: 1, y: 1 }]);

  it('H13 同一条目从合格变不合规：指出条目、实测与两版各自限值', () => {
    const oldV = validation([], true);
    const newV = validation(
      [{ severity: 'error', type: 'TRAVEL_EXCEED', roomId: room.id, message: '超', value: 45, limit: 40 }],
      false,
    );
    const { flips, fromPass, toPass } = diffCompliance(snap, DEFAULT_RULES.office, oldV, snap, DEFAULT_RULES.office, newV);
    expect(fromPass).toBe(true);
    expect(toPass).toBe(false);
    expect(flips).toHaveLength(1);
    const f = flips[0];
    expect(f.from).toBe('pass');
    expect(f.to).toBe('fail');
    expect(f.subjectName).toBe('101');
    expect(f.fromValue).toBe('合格');
    expect(f.toValue).toContain('45.0m');
    expect(f.toLimit).toContain('40');
  });

  it('H14 反过来：不合规 → 合格也列出', () => {
    const oldV = validation(
      [{ severity: 'error', type: 'DEADEND_EXCEED', message: '超', value: 30, limit: 22 }],
      false,
    );
    const newV = validation([], true);
    const { flips } = diffCompliance(snap, DEFAULT_RULES.office, oldV, snap, DEFAULT_RULES.office, newV);
    expect(flips).toHaveLength(1);
    expect(flips[0].from).toBe('fail');
    expect(flips[0].to).toBe('pass');
  });

  it('H15 规则也改过：两版限值各取各的（旧 40m / 新 30m）', () => {
    const oldRules = { ...DEFAULT_RULES.office, maxTravelDistanceM: 40, version: 1 };
    const newRules = { ...DEFAULT_RULES.office, maxTravelDistanceM: 30, version: 2 };
    const oldV = validation([], true, 1);
    const newV = validation(
      [{ severity: 'error', type: 'TRAVEL_EXCEED', roomId: room.id, message: '超', value: 35, limit: 30 }],
      false,
      2,
    );
    const { flips } = diffCompliance(snap, oldRules, oldV, snap, newRules, newV);
    expect(flips).toHaveLength(1);
    expect(flips[0].fromLimit).toContain('40m');
    expect(flips[0].toLimit).toContain('30m');
  });

  it('H16 检查台账类条目不参与平面合规对照', () => {
    const v1 = validation([{ severity: 'warning', type: 'CHECK_OVERDUE', facilityId: 'x', message: '过期' }], true);
    const v2 = validation([], true);
    const { flips } = diffCompliance(snap, DEFAULT_RULES.office, v1, snap, DEFAULT_RULES.office, v2);
    expect(flips).toHaveLength(0);
  });

  it('H17 两版都不合格但实测变化不算翻转（结论未变）', () => {
    const v1 = validation(
      [{ severity: 'error', type: 'TRAVEL_EXCEED', roomId: room.id, message: '超', value: 45, limit: 40 }],
      false,
    );
    const v2 = validation(
      [{ severity: 'error', type: 'TRAVEL_EXCEED', roomId: room.id, message: '超', value: 55, limit: 40 }],
      false,
    );
    const { flips } = diffCompliance(snap, DEFAULT_RULES.office, v1, snap, DEFAULT_RULES.office, v2);
    expect(flips).toHaveLength(0);
  });
});
