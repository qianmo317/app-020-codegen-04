/** 端到端走查：完整用户链路（建层→画走道/房间→换出口→规则改→合规翻转→回退→检查台账保留） */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getState, addBuilding, deleteBuilding, addFloor, addRoom, addFacility,
  deleteFacility, rollbackFloor, setLastValidation,
} from '../src/store/store';
import { validateFloor } from '../src/lib/engine';
import { DEFAULT_RULES } from '../src/rules/defaults';
import { diffCompliance, diffPlans, namesOf } from '../src/lib/history';
import type { Pt, FloorSnapshot } from '../src/model';

const M = 1000;
const rect = (x: number, y: number, w: number, h: number): Pt[] => [
  { x: x*M, y: y*M }, { x: (x+w)*M, y: y*M }, { x: (x+w)*M, y: (y+h)*M }, { x: x*M, y: (y+h)*M },
];
let bid='', fid='';
beforeEach(() => {
  for (const b of [...getState().buildings]) deleteBuilding(b.id);
  bid = addBuilding('楼', 'office'); fid = addFloor(bid, 1);
});

describe('完整链路', () => {
  it('E2E：画→校验→删出口致不合规→规则不变→回退恢复合规，历史全程可对照', () => {
    vi.useFakeTimers();
    // v2：41m 走道 + 两端出口 + 灭火器（办公规则全过）
    addRoom(fid, rect(0,0,41,2), '走道', 'corridor');
    const e1 = addFacility(fid, 'exit', 500, 1000);
    const e2 = addFacility(fid, 'exit', 40500, 1000);
    addFacility(fid, 'extinguisher', 20500, 1000);
    let f = getState().floors[fid];
    const okV = validateFloor(f, DEFAULT_RULES.office);
    expect(okV.pass).toBe(true);
    setLastValidation(fid, okV);

    // 找到「双出口都在」的那版 seq
    const goodSeq = getState().floors[fid].history!.length; // 初始1 + 走道 + 2出口 + 灭火器 = 5
    expect(goodSeq).toBe(5);

    // v6：拆掉一个出口 → 死端超限，不合规
    deleteFacility(fid, e2);
    f = getState().floors[fid];
    const badV = validateFloor(f, DEFAULT_RULES.office);
    expect(badV.pass).toBe(false);
    expect(badV.items.some(i => i.type === 'DEADEND_EXCEED')).toBe(true);
    setLastValidation(fid, badV);

    // 对照 好版→坏版：DEADEND 翻转，限值两版相同（规则没改）
    const h = getState().floors[fid].history!;
    const good = h.find(r => r.seq === goodSeq)!;
    const bad = h[h.length-1];
    const snap: FloorSnapshot = { rooms: f.rooms, facilities: f.facilities, exits: f.exits };
    const d = diffCompliance(good.validation, bad.validation, namesOf(snap));
    expect(d.flips.some(x => x.type==='DEADEND_EXCEED' && x.direction==='pass_to_fail' && x.oldLimit===x.newLimit)).toBe(true);
    // 图面 diff 标出删了出口
    const pd = diffPlans(good.snapshot, bad.snapshot);
    expect([...pd.removedFacilities]).toContain(e2);
    // 指标：出口 2→1
    expect(bad.metrics.exitCount - good.metrics.exitCount).toBe(-1);
    expect(bad.metrics.corridorLengthM).toBeCloseTo(good.metrics.corridorLengthM!, 0);

    // 回退到好版 → 重新合规（用当前同样的规则）
    const beforeLen = h.length;
    expect(rollbackFloor(fid, goodSeq)).toBe(true);
    f = getState().floors[fid];
    expect(f.facilities.filter(x=>x.kind==='exit')).toHaveLength(2);
    expect(getState().floors[fid].history!.length).toBe(beforeLen+1);
    const restoredV = validateFloor(f, DEFAULT_RULES.office);
    expect(restoredV.pass).toBe(true);
    setLastValidation(fid, restoredV);
    const h2 = getState().floors[fid].history!;
    const rb = h2[h2.length-1];
    expect(rb.origin).toBe('rollback');
    expect(rb.restoredSeq).toBe(goodSeq);
    expect(rb.validation?.pass).toBe(true);
    // 被删的出口以原 id 恢复，旧版一条没少
    expect(f.facilities.some(x => x.id === e2)).toBe(true);
    expect(h2.some(r => r.seq === goodSeq)).toBe(true);
    expect(h2.some(r => r.seq === beforeLen)).toBe(true); // 坏版也还在
    vi.useRealTimers();
  });
});
