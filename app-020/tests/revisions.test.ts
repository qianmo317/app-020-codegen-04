/**
 * 版本历史的 store 流程：
 * - 新建楼层即有初始版；每次平面改动追加一版并写清改了什么
 * - 连续属性编辑合并；台账/规格改动不建版
 * - 旧数据（无 revisions）首次编辑前补建初始版
 * - 一键回退：覆盖平面 + 新增 rollback 版 + 历史不删 + 台账保留
 * - setLastValidation 只回填最新版，旧版合规结论定格
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getState,
  addBuilding,
  deleteBuilding,
  addFloor,
  addRoom,
  updateRoom,
  moveRoom,
  deleteRoom,
  addFacility,
  moveFacility,
  deleteFacility,
  addCheck,
  updateFacility,
  restoreRevision,
  setLastValidation,
  updateRules,
} from '../src/store/store';
import { DEFAULT_RULES } from '../src/rules/defaults';
import { validateFloor } from '../src/lib/engine';
import type { Floor, Pt } from '../src/model';

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
  bid = addBuilding('版本测试楼', 'office');
  fid = addFloor(bid, 1);
});

const revs = () => getState().floors[fid].revisions!;
const floor = () => getState().floors[fid];

describe('建版', () => {
  it('V1 新建楼层即有 v1 初始版（空平面）', () => {
    const r = revs();
    expect(r).toHaveLength(1);
    expect(r[0].seq).toBe(1);
    expect(r[0].kind).toBe('baseline');
    expect(r[0].metrics).toEqual({ areaM2: 0, roomCount: 0, exitCount: 0, corridorLengthM: 0 });
    expect(r[0].rules.version).toBe(DEFAULT_RULES.office.version);
  });

  it('V2 加房间 → v2，summary/明细写明「新增房间」，指标更新', () => {
    addRoom(fid, rect(0, 0, 8, 6), '101室', 'office');
    const r = revs();
    expect(r).toHaveLength(2);
    expect(r[1].kind).toBe('edit');
    expect(r[1].summary).toContain('新增房间');
    expect(r[1].changes[0].label).toBe('101室');
    expect(r[1].metrics.roomCount).toBe(1);
    expect(r[1].metrics.areaM2).toBeCloseTo(48, 5);
    // 旧版不动
    expect(r[0].metrics.roomCount).toBe(0);
  });

  it('V3 加出口/删出口分别成条，出口数指标联动', () => {
    const eid = addFacility(fid, 'exit', 500, 500);
    expect(revs()[revs().length - 1].summary).toContain('新增出口');
    expect(revs()[revs().length - 1].metrics.exitCount).toBe(1);
    deleteFacility(fid, eid);
    const head = revs()[revs().length - 1];
    expect(head.summary).toContain('删除出口');
    expect(head.metrics.exitCount).toBe(0);
  });

  it('V4 挪房间与后续删除都各自成版（墙体形变的识别见 history.test H7）', () => {
    const rid = addRoom(fid, rect(0, 0, 8, 6), '101室', 'office');
    moveRoom(fid, rid, 0, 2000);
    expect(revs()[revs().length - 1].changes[0].kind).toBe('room_moved');
    deleteRoom(fid, rid);
    expect(revs()[revs().length - 1].summary).toContain('删除房间');
    expect(floor().rooms).toHaveLength(0);
  });

  it('V5 明细里移动距离以米计', () => {
    const rid = addRoom(fid, rect(0, 0, 8, 6), '101室', 'office');
    moveRoom(fid, rid, 3000, 4000);
    const head = revs()[revs().length - 1];
    expect(head.changes[0].kind).toBe('room_moved');
    expect(head.changes[0].detail).toContain('5.0m');
  });
});

describe('合并与噪声过滤', () => {
  it('V6 10 秒内连续改名并入上一版；超时后另开一版', () => {
    const rid = addRoom(fid, rect(0, 0, 8, 6), '101室', 'office');
    const nAfterAdd = revs().length;
    // 加房间那一版是 edit，第一次改名（同房间属性键、窗口内）并入它
    updateRoom(fid, rid, { name: 'A' });
    updateRoom(fid, rid, { name: 'AB' });
    updateRoom(fid, rid, { name: 'ABC' });
    expect(revs()).toHaveLength(nAfterAdd); // 没新增版本
    const head = revs()[nAfterAdd - 1];
    // 明细按「基线（初始版）→当前」重算：新增房间 + 改名各一条
    expect(head.changes.some((c) => c.kind === 'room_added')).toBe(true);
    expect(head.changes.filter((c) => c.kind === 'room_renamed')).toHaveLength(1);
    expect(head.changes.find((c) => c.kind === 'room_renamed')?.detail).toContain('ABC');
    expect(floor().rooms[0].name).toBe('ABC');

    // 超出合并窗口后另开一版
    const old = new Date(head.createdAt).getTime();
    head.createdAt = new Date(old - 11_000).toISOString();
    updateRoom(fid, rid, { name: 'ABCD' });
    expect(revs()).toHaveLength(nAfterAdd + 1);
    // 新版明细只含相对上一版的一次改名
    const fresh = revs()[revs().length - 1];
    expect(fresh.changes.map((c) => c.kind)).toEqual(['room_renamed']);
    expect(fresh.changes[0].detail).toContain('ABCD');
  });

  it('V6b 合并产生新对象，旧引用不被原地修改（useSyncExternalStore 语义）', () => {
    const rid = addRoom(fid, rect(0, 0, 8, 6), '101室', 'office');
    const headBefore = revs()[1];
    const snapBefore = headBefore.snapshot;
    updateRoom(fid, rid, { name: '新名字' });
    const headAfter = revs()[1];
    expect(headAfter).not.toBe(headBefore); // 同 seq 但对象已替换
    expect(headBefore.snapshot).toBe(snapBefore); // 旧引用快照未被改写
    expect(headBefore.changes.some((c) => c.kind === 'room_renamed')).toBe(false);
    expect(headAfter.snapshot).not.toBe(snapBefore);
  });

  it('V7 检查台账/灭火器规格改动不建版', () => {
    const xid = addFacility(fid, 'extinguisher', 1000, 1000);
    const n = revs().length;
    addCheck(fid, xid, { date: '2026-09-01', status: 'ok' });
    updateFacility(fid, xid, { spec: { extType: 'co2', weightKg: 2 } });
    expect(revs()).toHaveLength(n);
  });

  it('V8 无实际平面变化的调用不建版', () => {
    addRoom(fid, rect(0, 0, 8, 6), '101', 'office');
    const n = revs().length;
    moveRoom(fid, 'nonexistent', 1000, 1000);
    updateRoom(fid, 'nonexistent', { name: 'x' });
    expect(revs()).toHaveLength(n);
  });
});

describe('旧数据迁移', () => {
  it('V9 无 revisions 的旧楼层首次编辑前补建初始版，再追加编辑版', () => {
    const legacy: Floor = {
      id: fid,
      buildingId: bid,
      level: 1,
      scaleMmPerUnit: 1,
      rooms: [],
      facilities: [],
      exits: [],
      version: 0,
    };
    // 直接替换 store 内楼层，模拟旧版本 localStorage 数据
    const s = getState();
    (s as unknown as { floors: Record<string, Floor> }).floors[fid] = legacy;
    addRoom(fid, rect(0, 0, 4, 4), '旧楼房间', 'office');
    const r = getState().floors[fid].revisions!;
    expect(r.length).toBeGreaterThanOrEqual(2);
    expect(r[0].kind).toBe('baseline');
    expect(r[0].summary).toBe('初始平面');
    expect(r[r.length - 1].summary).toContain('新增房间');
  });
});

describe('回退', () => {
  it('V10 回退到旧版：平面被覆盖、历史不删、新增 rollback 版并注明来源', () => {
    const r1 = addRoom(fid, rect(0, 0, 8, 6), '101室', 'office');
    const targetSeq = revs()[revs().length - 1].seq; // 「只有 101」那一版
    addRoom(fid, rect(10, 0, 8, 6), '102室', 'office');
    expect(floor().rooms).toHaveLength(2);
    const totalBefore = revs().length;

    restoreRevision(fid, revs().find((x) => x.seq === targetSeq)!.id);

    expect(floor().rooms).toHaveLength(1);
    expect(floor().rooms[0].id).toBe(r1);
    expect(floor().rooms[0].name).toBe('101室');
    // 历史一条没少，还多了一版回退
    const after = revs();
    expect(after).toHaveLength(totalBefore + 1);
    const rb = after[after.length - 1];
    expect(rb.kind).toBe('rollback');
    expect(rb.rollbackFromSeq).toBe(targetSeq);
    expect(rb.summary).toBe(`回退到 v${targetSeq}`);
    expect(rb.snapshot.rooms).toHaveLength(1);
    // 回退版里写清了这次改了什么（删除了 102）
    expect(rb.changes.some((c) => c.kind === 'room_removed' && c.label === '102室')).toBe(true);
  });

  it('V11 回退恢复的设施沿用旧 id/编号，快照内台账一并找回；现存设施保留当前台账', () => {
    const eid = addFacility(fid, 'exit', 500, 500);
    addCheck(fid, eid, { date: '2026-09-01', status: 'ok' }); // 台账变化不建版
    // 再做一次平面编辑，使最新版快照里的出口带着台账
    addRoom(fid, rect(0, 0, 4, 4), '101', 'office');
    const withChecksSeq = revs()[revs().length - 1].seq;
    deleteFacility(fid, eid);
    expect(floor().facilities.some((x) => x.kind === 'exit')).toBe(false);

    restoreRevision(fid, revs().find((x) => x.seq === withChecksSeq)!.id);
    const restored = floor().facilities.find((f) => f.id === eid);
    expect(restored).toBeTruthy();
    expect(restored!.code).toContain('EXIT-01');
    expect(restored!.checks).toHaveLength(1); // 台账随快照找回
    expect(floor().exits).toEqual([eid]);
    expect(floor().rooms).toHaveLength(1);
  });

  it('V12 已是最新版时回退为无变化（不产生重复版本）', () => {
    addRoom(fid, rect(0, 0, 8, 6), '101室', 'office');
    const n = revs().length;
    restoreRevision(fid, revs()[n - 1].id);
    expect(revs()).toHaveLength(n);
  });
});

describe('合规结果定格', () => {
  it('V13 建版时保存当时规则与校验；后改规则只影响后续版本，旧版限值定格', () => {
    addRoom(fid, rect(0, 0, 50, 20), '大厅', 'office'); // 1000㎡
    addFacility(fid, 'exit', 500, 500);
    const rules = DEFAULT_RULES.office;
    const frozenHead = revs()[revs().length - 1];
    setLastValidation(fid, validateFloor(floor(), rules));
    expect(frozenHead.rules.maxTravelDistanceM).toBe(40);

    // 规则收紧后再做一次平面改动：新版按 v2 规则建版并校验
    updateRules('office', { maxTravelDistanceM: 20 });
    moveFacility(fid, floor().facilities[0].id, 600, 600);

    const frozen = revs().find((r) => r.id === frozenHead.id)!;
    expect(frozen.rules.maxTravelDistanceM).toBe(40);
    expect(frozen.validation?.rulesSnapshot.maxTravelDistanceM).toBe(40);
    const nowHead = revs()[revs().length - 1];
    expect(nowHead.id).not.toBe(frozenHead.id);
    expect(nowHead.rules.maxTravelDistanceM).toBe(20);
  });

  it('V14 规则只改、平面没改时，setLastValidation 回填最新版（编辑器自动校验路径）', () => {
    updateRules('office', { maxTravelDistanceM: 40 }); // 排除其他用例的规则污染
    addRoom(fid, rect(0, 0, 8, 6), '101', 'office');
    setLastValidation(fid, validateFloor(floor(), DEFAULT_RULES.office));
    updateRules('office', { maxTravelDistanceM: 20 });
    setLastValidation(fid, validateFloor(floor(), getState().rules.office));
    // 没有新版本产生
    expect(revs().filter((r) => r.kind === 'edit')).toHaveLength(1);
    // 最新版校验结果反映新规则（按当前规则重算）；建版时规则对象定格在 40，
    // 两版限值差异通过「改规则后再编辑」产生的新版本体现（见 V13）
    expect(revs()[revs().length - 1].validation?.rulesSnapshot.maxTravelDistanceM).toBe(20);
    expect(revs()[revs().length - 1].rules.maxTravelDistanceM).toBe(40);
  });
});
