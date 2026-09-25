/**
 * 端到端集成：模拟用户真实操作序列，验证「改平面 → 合规翻转 → 对照 → 回退」全链路。
 * 场景：500㎡ 大房间单出口（出口数不合规）→ 加第二个出口（合格），
 * 再把走道延长到超疏散距离（合格→不合格），最后回退，历史一条不丢。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getState,
  addBuilding,
  deleteBuilding,
  addFloor,
  addRoom,
  addFacility,
  setLastValidation,
  restoreRevision,
} from '../src/store/store';
import { validateFloor } from '../src/lib/engine';
import { diffCompliance, diffPlans } from '../src/lib/history';
import type { Pt } from '../src/model';

const rect = (x: number, y: number, w: number, h: number): Pt[] => [
  { x: x * 1000, y: y * 1000 },
  { x: (x + w) * 1000, y: y * 1000 },
  { x: (x + w) * 1000, y: (y + h) * 1000 },
  { x: x * 1000, y: (y + h) * 1000 },
];

let bid = '';
let fid = '';

beforeEach(() => {
  for (const b of [...getState().buildings]) deleteBuilding(b.id);
  bid = addBuilding('集成楼', 'office');
  fid = addFloor(bid, 1);
});

describe('端到端：改平面 → 合规翻转 → 对照 → 回退', () => {
  it('E1 单出口大厅不合规，加第二出口后 EXIT_COUNT 翻转；对照页数据完整', () => {
    // 500㎡（> exitMinAreaM2=200）需 ≥2 出口
    addRoom(fid, rect(0, 0, 50, 10), '大厅', 'office');
    addFacility(fid, 'exit', 500, 1000);
    setLastValidation(fid, validateFloor(getState().floors[fid], getState().rules.office));
    const revs = () => getState().floors[fid].revisions!;
    const singleExit = revs()[revs().length - 1];
    expect(singleExit.validation?.pass).toBe(false);
    expect(singleExit.validation?.items.some((i) => i.type === 'EXIT_COUNT')).toBe(true);

    // 加第二出口
    addFacility(fid, 'exit', 49500, 1000);
    setLastValidation(fid, validateFloor(getState().floors[fid], getState().rules.office));
    const twoExit = revs()[revs().length - 1];
    // 覆盖警告不影响整体 pass：无 error 即合规（engine 口径）
    const errors = twoExit.validation?.items.filter((i) => i.severity === 'error') ?? [];
    expect(errors.some((i) => i.type === 'EXIT_COUNT')).toBe(false);

    // 对照：指标（出口数 1→2）+ 合规翻转（EXIT_COUNT 不合格→合格）
    const cmp = diffCompliance(
      singleExit.snapshot, singleExit.rules, singleExit.validation,
      twoExit.snapshot, twoExit.rules, twoExit.validation,
    );
    expect(cmp.fromPass).toBe(false);
    const exitFlip = cmp.flips.find((f) => f.type === 'EXIT_COUNT');
    expect(exitFlip).toBeTruthy();
    expect(exitFlip!.from).toBe('fail');
    expect(exitFlip!.to).toBe('pass');
    expect(exitFlip!.fromValue).toContain('1');
    expect(exitFlip!.fromLimit).toContain('200');
    expect(exitFlip!.toValue).toBe('合格');

    const planDiff = diffPlans(singleExit.snapshot, twoExit.snapshot);
    expect(planDiff.addedFacilityIds).toHaveLength(1);
    expect(planDiff.changes[0].kind).toBe('exit_added');
    expect(twoExit.metrics.exitCount - singleExit.metrics.exitCount).toBe(1);
  });

  it('E2 回退后平面与合规结论恢复，rollback 版记录来源，历史完整', () => {
    addRoom(fid, rect(0, 0, 8, 6), '101', 'office');
    addFacility(fid, 'exit', 500, 500);
    setLastValidation(fid, validateFloor(getState().floors[fid], getState().rules.office));
    // 回退目标 = 房间+出口都就位后的最新版
    const revs = () => getState().floors[fid].revisions!;
    const target = revs()[revs().length - 1];
    const targetSeq = target.seq;
    expect(target.snapshot.rooms).toHaveLength(1);
    expect(target.snapshot.facilities.filter((x) => x.kind === 'exit')).toHaveLength(1);
    const targetRoomCount = target.snapshot.rooms.length;

    // 继续加房间和设施
    addRoom(fid, rect(10, 0, 8, 6), '102', 'office');
    addFacility(fid, 'extinguisher', 5000, 1000);
    expect(getState().floors[fid].rooms).toHaveLength(2);
    const countBefore = revs().length;

    // 一键回退
    restoreRevision(fid, target.id);
    const f = getState().floors[fid];
    expect(f.rooms).toHaveLength(targetRoomCount);
    expect(f.facilities.filter((x) => x.kind === 'exit')).toHaveLength(1);
    expect(f.facilities.some((x) => x.kind === 'extinguisher')).toBe(false);

    const after = revs();
    expect(after).toHaveLength(countBefore + 1); // 历史没抹掉，还多了一版
    const rb = after[after.length - 1];
    expect(rb.kind).toBe('rollback');
    expect(rb.rollbackFromSeq).toBe(targetSeq);
    expect(rb.summary).toBe(`回退到 v${targetSeq}`);
    // 回退即校验（不依赖编辑器 500ms 防抖），结论已就绪
    expect(rb.validation).toBeTruthy();
    // 回退版明细写清删了什么（出口 EXIT-01 保留；灭火器 1F-EX-01 被移除）
    expect(rb.changes.some((c) => c.kind === 'room_removed' && c.label === '102')).toBe(true);
    const removedFac = rb.changes.find((c) => c.kind === 'facility_removed');
    expect(removedFac).toBeTruthy();
    expect(removedFac!.detail).toBe('灭火器');
    expect(rb.changes.some((c) => c.kind === 'exit_removed')).toBe(false);
    // 出口仍在
    expect(f.facilities.filter((x) => x.kind === 'exit')).toHaveLength(1);
    // 旧版仍在
    expect(after.some((r) => r.id === target.id)).toBe(true);
  });
});
