import { useEffect, useMemo, useRef, useState } from 'react';
import type { Floor, FloorMetrics, FloorRevision, PlanChange } from '../model';
import { useStore, rollbackFloor } from '../store/store';
import { floorLabel } from '../store/id';
import { Link } from '../router';
import { bboxOf } from '../lib/geometry';
import {
  COMPLIANCE_LABELS,
  PLAN_CHANGE_LABELS,
  diffCompliance,
  diffPlans,
  snapshotToFloor,
} from '../lib/history';
import { FloorPlan, wheelZoom, type DiffMarks, type View } from '../components/FloorPlan';

type Props = { floorId: string };

const fmtArea = (v: number) => `${v.toFixed(1)}㎡`;
const fmtLen = (v: number | null) => (v == null ? '—' : `${v.toFixed(1)}m`);

function deltaText(delta: number, fmt: (v: number) => string): { text: string; cls: string } {
  if (Math.abs(delta) < 0.05) return { text: '±0', cls: 'hint' };
  const sign = delta > 0 ? '+' : '−';
  return { text: `${sign}${fmt(Math.abs(delta))}`, cls: delta > 0 ? 'good' : 'bad' };
}

/** 把一版快照包成 FloorPlan 需要的 Floor（仅取渲染所需字段） */
function revisionFloor(rev: FloorRevision, base: Floor): Floor {
  return snapshotToFloor(rev.snapshot, {
    ...base,
    version: 0,
    lastValidation: rev.validation ?? undefined,
  });
}

function combinedBBox(a?: FloorRevision, b?: FloorRevision) {
  const polys = [...(a?.snapshot.rooms ?? []), ...(b?.snapshot.rooms ?? [])].map((r) => r.polygon);
  if (!polys.length) return { minX: -5000, minY: -5000, maxX: 45000, maxY: 30000 };
  return bboxOf(polys);
}

export function HistoryPage({ floorId }: Props) {
  const floor = useStore((s) => s.floors[floorId]);
  const building = useStore((s) => s.buildings.find((b) => b.id === floor?.buildingId));
  const revs = floor?.history ?? [];

  const [oldSeq, setOldSeq] = useState<number | null>(null);
  const [newSeq, setNewSeq] = useState<number | null>(null);
  const [view, setView] = useState<View>({ cx: 20000, cy: 10000, zoom: 0.05 });

  // 默认对照：最新两版；回退产生新版本后自动把新版选择器跟到最新版
  const latestSeq = revs.length ? revs[revs.length - 1].seq : null;
  const prevLatestRef = useRef<number | null>(null);
  useEffect(() => {
    if (latestSeq == null) return;
    const prevLatest = prevLatestRef.current;
    prevLatestRef.current = latestSeq;
    if (prevLatest == null) {
      // 首次进入：默认 倒数第二版 → 最新版
      setNewSeq(latestSeq);
      setOldSeq(revs.length >= 2 ? revs[revs.length - 2].seq : latestSeq);
    } else if (latestSeq !== prevLatest) {
      // 产生了新版本（如回退）：新版选择器跟到最新，旧版选择器停在产生前的最新版
      setNewSeq(latestSeq);
      setOldSeq(prevLatest);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestSeq]);

  // 切换对照版本时按两版并集范围适配视野
  useEffect(() => {
    const a = revs.find((r) => r.seq === oldSeq);
    const b = revs.find((r) => r.seq === newSeq);
    if (!a && !b) return;
    const bb = combinedBBox(a, b);
    const wMm = bb.maxX - bb.minX + 8000;
    const hMm = bb.maxY - bb.minY + 8000;
    setView({
      cx: (bb.minX + bb.maxX) / 2,
      cy: (bb.minY + bb.maxY) / 2,
      zoom: Math.min(900 / wMm, 360 / hMm),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oldSeq, newSeq]);

  const oldRev = revs.find((r) => r.seq === oldSeq) ?? null;
  const newRev = revs.find((r) => r.seq === newSeq) ?? null;

  const planDiff = useMemo(() => {
    if (!oldRev || !newRev) return null;
    return diffPlans(oldRev.snapshot, newRev.snapshot);
  }, [oldRev, newRev]);

  const compliance = useMemo(() => {
    if (!oldRev || !newRev) return null;
    // 名称以新版为准（被删除的房间/设施名回退到旧版取）
    const mergedNames = {
      room: (id?: string) =>
        newRev.snapshot.rooms.find((r) => r.id === id)?.name ??
        oldRev.snapshot.rooms.find((r) => r.id === id)?.name,
      facility: (id?: string) =>
        newRev.snapshot.facilities.find((f) => f.id === id)?.code ??
        oldRev.snapshot.facilities.find((f) => f.id === id)?.code,
    };
    return diffCompliance(oldRev.validation, newRev.validation, mergedNames);
  }, [oldRev, newRev]);

  if (!floor) {
    return <div className="page">楼层不存在。<Link to="/">返回首页</Link></div>;
  }

  const marksFor = (side: 'old' | 'new'): DiffMarks | null => {
    if (!planDiff) return null;
    return {
      active: true,
      roomStatus: new Map([
        ...[...planDiff.addedRooms].map((id) => [id, side === 'new' ? 'added' : 'removed'] as const),
        ...[...planDiff.removedRooms].map((id) => [id, side === 'old' ? 'removed' : 'added'] as const),
        ...[...planDiff.changedRooms].map((id) => [id, 'changed'] as const),
      ]),
      facilityStatus: new Map([
        ...[...planDiff.addedFacilities].map((id) => [id, side === 'new' ? 'added' : 'removed'] as const),
        ...[...planDiff.removedFacilities].map((id) => [id, side === 'old' ? 'removed' : 'added'] as const),
        ...[...planDiff.changedFacilities].map((id) => [id, 'changed'] as const),
      ]),
    };
  };

  // 并排两图共享平移缩放
  const panRef = useRef<{ startX: number; startY: number; cx: number; cy: number } | null>(null);
  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    panRef.current = { startX: e.clientX, startY: e.clientY, cx: view.cx, cy: view.cy };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const p = panRef.current;
    if (!p) return;
    setView({
      ...view,
      cx: p.cx - (e.clientX - p.startX) / view.zoom,
      cy: p.cy - (e.clientY - p.startY) / view.zoom,
    });
  };
  const onUp = () => { panRef.current = null; };
  const onWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    // 用事件目标自身的 rect：在任一张图上滚轮都以光标为锚缩放
    setView(wheelZoom(view, e, e.currentTarget));
  };

  const doRollback = (seq: number) => {
    const rev = revs.find((r) => r.seq === seq);
    if (!rev) return;
    if (confirm(`回退到 v${seq}（${rev.summary}）？\n当前平面会被该版替换，回退动作本身另存为一个新版本，历史不会删除。`)) {
      rollbackFloor(floorId, seq);
    }
  };

  return (
    <div className="page history-page">
      <div className="toolbar">
        <Link to={`/floor/${floorId}`}>← 返回 {building?.name ?? ''} {floorLabel(floor.level)} 编辑器</Link>
      </div>
      <h2>{building?.name ?? '建筑'} · {floorLabel(floor.level)} 平面版本对照</h2>

      {/* 版本选择 */}
      <div className="cmp-selectors">
        <label className="cmp-sel">
          旧版
          <select value={oldSeq ?? ''} onChange={(e) => setOldSeq(Number(e.target.value))}>
            {revs.map((r) => (
              <option key={r.seq} value={r.seq}>v{r.seq} · {new Date(r.createdAt).toLocaleString('zh-CN')}</option>
            ))}
          </select>
        </label>
        <span className="cmp-arrow">→</span>
        <label className="cmp-sel">
          新版
          <select value={newSeq ?? ''} onChange={(e) => setNewSeq(Number(e.target.value))}>
            {revs.map((r) => (
              <option key={r.seq} value={r.seq}>v{r.seq} · {new Date(r.createdAt).toLocaleString('zh-CN')}</option>
            ))}
          </select>
        </label>
        <span className="hint">两图联动缩放，可拖动画布 / 滚轮缩放</span>
      </div>

      {oldRev && newRev && compliance && (
        <>
          {/* 并排图纸 */}
          <div className="cmp-maps">
            <CmpMap
              title={`旧版 v${oldRev.seq}`}
              sub={oldRev.summary}
              rev={oldRev}
              floor={floor}
              view={view}
              pass={oldRev.validation?.pass ?? null}
              diffMarks={marksFor('old')}
              onDown={onDown}
              onMove={onMove}
              onUp={onUp}
              onWheel={onWheel}
            />
            <CmpMap
              title={`新版 v${newRev.seq}`}
              sub={newRev.summary}
              rev={newRev}
              floor={floor}
              view={view}
              pass={newRev.validation?.pass ?? null}
              diffMarks={marksFor('new')}
              current
              onDown={onDown}
              onMove={onMove}
              onUp={onUp}
              onWheel={onWheel}
              onRollback={() => doRollback(oldRev.seq)}
              canRollback={oldRev.seq !== newRev.seq}
            />
          </div>

          {/* 合规翻转 */}
          <section className="section">
            <h3>合规结论变化</h3>
            <div className="cmp-verdict">
              <Verdict pass={compliance.oldPass} label={`旧版 v${oldRev.seq}`} />
              <span className="cmp-arrow">→</span>
              <Verdict pass={compliance.newPass} label={`新版 v${newRev.seq}`} />
            </div>
            {compliance.flips.length === 0 ? (
              <p className="hint">
                两版之间没有逐条规则的合格↔不合规翻转
                {compliance.oldPass === compliance.newPass && compliance.oldPass !== null && compliance.newPass !== null
                  ? '（两版整体结论一致）'
                  : ''}
              </p>
            ) : (
              <table className="table flip-table">
                <thead>
                  <tr>
                    <th>变化</th><th>规则条目</th>
                    <th>旧版实测 / 当时限值</th><th>新版实测 / 当时限值</th><th>限值依据（规则版本）</th>
                  </tr>
                </thead>
                <tbody>
                  {compliance.flips.map((fl, i) => (
                    <tr key={i} className={fl.direction === 'pass_to_fail' ? 'flip-bad' : 'flip-good'}>
                      <td>
                        <span className={`badge ${fl.direction === 'pass_to_fail' ? 'st-damaged' : 'st-ok'}`}>
                          {fl.direction === 'pass_to_fail' ? '合格 → 不合规' : '不合规 → 合格'}
                        </span>
                      </td>
                      <td><b>{COMPLIANCE_LABELS[fl.type] ?? fl.type}</b><br /><span className="hint">{fl.label}</span></td>
                      <td>
                        {fl.oldValue != null ? `${fmtVal(fl.type, fl.oldValue)} ` : '—'}
                        {fl.oldLimit != null && <span className="hint">/ 限值 {fmtVal(fl.type, fl.oldLimit, true)}</span>}
                      </td>
                      <td>
                        {fl.newValue != null ? `${fmtVal(fl.type, fl.newValue)} ` : '—'}
                        {fl.newLimit != null && <span className="hint">/ 限值 {fmtVal(fl.type, fl.newLimit, true)}</span>}
                      </td>
                      <td className="hint">
                        旧：v{fl.oldRuleVersion} {fl.oldRuleSource}
                        <br />
                        新：v{fl.newRuleVersion} {fl.newRuleSource}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {(oldRev.validation == null || newRev.validation == null) && (
              <p className="hint">注：标「未校验」的版本是改动后尚未自动校验（例如连续快速编辑），其限值留空。</p>
            )}
          </section>

          {/* 指标差异 */}
          <section className="section">
            <h3>指标差异</h3>
            <MetricsTable oldM={oldRev.metrics} newM={newRev.metrics} />
          </section>

          {/* 图元改动清单（始终展示所选两版之间的差异） */}
          <section className="section">
            <h3>图元改动（v{oldRev.seq} → v{newRev.seq}，{planDiff?.changes.length ?? 0} 项）</h3>
            <ChangeChips changes={planDiff?.changes ?? []} />
          </section>
        </>
      )}

      {/* 全部历史版本 */}
      <section className="section">
        <h3>历史版本（共 {revs.length} 版）</h3>
        <table className="table">
          <thead>
            <tr><th>版本</th><th>时间</th><th>类型</th><th>改动说明</th><th>面积/房间/出口/走道</th><th>结论</th><th>操作</th></tr>
          </thead>
          <tbody>
            {[...revs].reverse().map((r) => (
              <tr key={r.seq} className={r.seq === newSeq ? 'rev-current' : ''}>
                <td><b>v{r.seq}</b>{r.seq === floor.historySeq && <span className="tag" style={{ marginLeft: 6 }}>当前</span>}</td>
                <td className="hint">{new Date(r.createdAt).toLocaleString('zh-CN')}</td>
                <td>{r.origin === 'rollback' ? <span className="tag">回退</span> : '编辑'}</td>
                <td>
                  {r.origin === 'rollback' && r.restoredSeq != null
                    ? <>回退自 v{r.rolledBackFrom}，内容恢复为 v{r.restoredSeq}</>
                    : r.summary}
                </td>
                <td className="hint">
                  {r.metrics.areaM2.toFixed(1)}㎡ · {r.metrics.roomCount} 房间 · {r.metrics.exitCount} 出口 · {fmtLen(r.metrics.corridorLengthM)}
                </td>
                <td>
                  {r.validation == null ? (
                    <span className="hint">未校验</span>
                  ) : (
                    <span className={`badge ${r.validation.pass ? 'st-ok' : 'st-damaged'}`}>
                      {r.validation.pass ? '合规' : '不合规'}
                    </span>
                  )}
                </td>
                <td>
                  <button className="ghost" onClick={() => { setOldSeq(r.seq); setNewSeq(floor.historySeq ?? r.seq); }}>对照</button>{' '}
                  {r.seq !== floor.historySeq && (
                    <button onClick={() => doRollback(r.seq)}>回退为本版</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hint">回退会保留所有检查记录，并把回退动作另存为新版本，历史记录不会被抹掉。每层最多保留最近 {100} 版。</p>
      </section>
    </div>
  );
}

function fmtVal(type: string, v: number, isLimit = false): string {
  if (type === 'COVERAGE_UNCOVERED') return isLimit ? `${v}m 半径` : `${v.toFixed(1)}㎡`;
  if (type === 'EXIT_COUNT') return isLimit ? `面积阈值 ${v}㎡` : `${v} 个`;
  return `${v.toFixed(1)}m`;
}

function Verdict({ pass, label }: { pass: boolean | null; label: string }) {
  if (pass === null) return <div className="cmp-badge none">{label}：未校验</div>;
  return (
    <div className={`cmp-badge ${pass ? 'pass' : 'fail'}`}>
      {label}：{pass ? '✔ 合规' : '✘ 不合规'}
    </div>
  );
}

function MetricsTable({ oldM, newM }: { oldM: FloorMetrics; newM: FloorMetrics }) {
  const rows: { label: string; old: string; now: string; delta: string; cls: string }[] = [
    (() => {
      const d = deltaText(newM.areaM2 - oldM.areaM2, (v) => v.toFixed(1));
      return { label: '总面积', old: fmtArea(oldM.areaM2), now: fmtArea(newM.areaM2), delta: d.text, cls: d.cls };
    })(),
    (() => {
      const d = newM.roomCount - oldM.roomCount;
      return {
        label: '房间数',
        old: `${oldM.roomCount}`,
        now: `${newM.roomCount}`,
        delta: d === 0 ? '±0' : `${d > 0 ? '+' : '−'}${Math.abs(d)}`,
        cls: d === 0 ? 'hint' : d > 0 ? 'good' : 'bad',
      };
    })(),
    (() => {
      const d = newM.exitCount - oldM.exitCount;
      return {
        label: '安全出口数',
        old: `${oldM.exitCount}`,
        now: `${newM.exitCount}`,
        delta: d === 0 ? '±0' : `${d > 0 ? '+' : '−'}${Math.abs(d)}`,
        cls: d === 0 ? 'hint' : d > 0 ? 'good' : 'bad',
      };
    })(),
    (() => {
      const has = oldM.corridorLengthM != null || newM.corridorLengthM != null;
      if (!has) return { label: '走道长度', old: '—', now: '—', delta: '—', cls: 'hint' };
      const a = oldM.corridorLengthM ?? 0;
      const b = newM.corridorLengthM ?? 0;
      const d = deltaText(b - a, (v) => v.toFixed(1));
      return { label: '走道长度', old: fmtLen(oldM.corridorLengthM), now: fmtLen(newM.corridorLengthM), delta: d.text, cls: d.cls };
    })(),
  ];
  return (
    <table className="table metrics-table">
      <thead><tr><th>指标</th><th>旧版</th><th>新版</th><th>变化</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <td>{r.label}</td><td>{r.old}</td><td><b>{r.now}</b></td><td className={r.cls}>{r.delta}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ChangeChips({ changes }: { changes: PlanChange[] }) {
  if (!changes.length) return <p className="hint">无图元改动</p>;
  // 同类型折叠展示，保留每个对象名
  const groups = new Map<string, PlanChange[]>();
  for (const c of changes) {
    const list = groups.get(c.kind) ?? [];
    list.push(c);
    groups.set(c.kind, list);
  }
  return (
    <div className="changelist">
      {[...groups.entries()].map(([kind, list]) => (
        <div key={kind} className={`change-group ck-${kind}`}>
          <b>{PLAN_CHANGE_LABELS[kind as PlanChange['kind']] ?? kind} ×{list.length}</b>
          <span className="hint">{list.map((c) => c.name).join('、')}</span>
        </div>
      ))}
    </div>
  );
}

function CmpMap({
  title, sub, rev, floor, view, pass, diffMarks, current,
  onDown, onMove, onUp, onWheel, onRollback, canRollback,
}: {
  title: string;
  sub: string;
  rev: FloorRevision;
  floor: Floor;
  view: View;
  pass: boolean | null;
  diffMarks: DiffMarks | null;
  current?: boolean;
  onDown: (e: React.PointerEvent<SVGSVGElement>) => void;
  onMove: (e: React.PointerEvent<SVGSVGElement>) => void;
  onUp: () => void;
  onWheel: (e: React.WheelEvent<SVGSVGElement>) => void;
  onRollback?: () => void;
  canRollback?: boolean;
}) {
  const rf = useMemo(() => revisionFloor(rev, floor), [rev, floor]);
  return (
    <div className={`cmp-map ${current ? 'is-current' : ''}`}>
      <div className="cmp-map-head">
        <div>
          <b>{title}</b>{current && <span className="tag" style={{ marginLeft: 6 }}>当前平面</span>}
          <div className="hint">{sub}</div>
        </div>
        <span className={`badge ${pass === null ? '' : pass ? 'st-ok' : 'st-damaged'}`}>
          {pass === null ? '未校验' : pass ? '合规' : '不合规'}
        </span>
      </div>
      <svg
        className="cmp-svg"
        viewBox={`${view.cx - 500 / view.zoom} ${view.cy - 300 / view.zoom} ${1000 / view.zoom} ${600 / view.zoom}`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={onUp}
        onWheel={onWheel}
      >
        <FloorPlan
          floor={rf}
          view={view}
          svgRef={{ current: null }}
          underlayUrl={null}
          showGrid
          selected={null}
          drag={null}
          dragDelta={{ x: 0, y: 0 }}
          draftPoints={[]}
          draftCursor={null}
          coverageCells={null}
          highlight={null}
          markPt={null}
          diffMarks={diffMarks}
        />
      </svg>
      <div className="cmp-map-foot">
        <span className="diff-legend">
          <i className="dlg added" /> 新增 <i className="dlg removed" /> 删除 <i className="dlg changed" /> 改动
        </span>
        {onRollback && canRollback && <button onClick={onRollback}>一键回退旧版为当前版</button>}
      </div>
    </div>
  );
}
