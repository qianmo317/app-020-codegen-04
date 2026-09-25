import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FloorRevision } from '../model';
import { useStore, restoreRevision } from '../store/store';
import { floorLabel } from '../store/id';
import { bboxOf } from '../lib/geometry';
import {
  COMPLIANCE_TYPE_LABELS,
  changeVerb,
  diffCompliance,
  diffPlans,
  floorFromSnapshot,
} from '../lib/history';
import { FloorPlan, mmFromEvent, wheelZoom, type PlanDiffMarks, type View } from '../components/FloorPlan';
import { Link } from '../router';

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const p2 = (v: number) => String(v).padStart(2, '0');
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

function deltaCell(before: number, after: number, unit: string, digits = 1): React.ReactNode {
  const d = after - before;
  const text = `${d > 0 ? '+' : ''}${d.toFixed(digits)}${unit}`;
  const cls = Math.abs(d) < Math.pow(10, -digits) / 2 ? 'hint' : d > 0 ? 'warn' : 'good';
  return <b className={cls} style={{ fontWeight: 600 }}>{text}</b>;
}

export function DiffPage({ floorId, revisionAId, revisionBId }: { floorId: string; revisionAId: string; revisionBId: string }) {
  const floor = useStore((s) => s.floors[floorId]);
  const building = useStore((s) => s.buildings.find((b) => b.id === floor?.buildingId));
  const revisions = floor?.revisions ?? [];
  const ra = revisions.find((r) => r.id === revisionAId);
  const rb = revisions.find((r) => r.id === revisionBId);

  // 统一旧→新方向（按 seq 排序），展示始终「左旧右新」
  const oldRev: FloorRevision | undefined = ra && rb && ra.seq > rb.seq ? rb : ra;
  const newRev: FloorRevision | undefined = ra && rb && ra.seq > rb.seq ? ra : rb;

  // 两张图共享视野，缩放/平移联动
  const [view, setView] = useState<View>({ cx: 20000, cy: 10000, zoom: 0.06 });
  const oldSvgRef = useRef<SVGSVGElement | null>(null);
  const newSvgRef = useRef<SVGSVGElement | null>(null);

  const diff = useMemo(
    () => (oldRev && newRev ? diffPlans(oldRev.snapshot, newRev.snapshot) : null),
    [oldRev, newRev],
  );
  const compliance = useMemo(
    () =>
      oldRev && newRev
        ? diffCompliance(
            oldRev.snapshot,
            oldRev.rules,
            oldRev.validation,
            newRev.snapshot,
            newRev.rules,
            newRev.validation,
          )
        : null,
    [oldRev, newRev],
  );

  // 切换对照版本时按两版总范围适配一次视野（需在 DOM 布局后测画布尺寸）
  useLayoutEffect(() => {
    if (!oldRev || !newRev) return;
    const polys = [...oldRev.snapshot.rooms, ...newRev.snapshot.rooms].map((r) => r.polygon);
    const el = oldSvgRef.current;
    const pxW = el?.clientWidth ?? 900;
    const pxH = el?.clientHeight ?? 520;
    if (!polys.length) {
      setView({ cx: 0, cy: 0, zoom: 0.05 });
      return;
    }
    const bb = bboxOf(polys);
    const wMm = bb.maxX - bb.minX + 8000;
    const hMm = bb.maxY - bb.minY + 8000;
    setView({
      cx: (bb.minX + bb.maxX) / 2,
      cy: (bb.minY + bb.maxY) / 2,
      zoom: Math.min(pxW / wMm, pxH / hMm),
    });
  }, [oldRev?.id, newRev?.id, oldRev, newRev]);

  if (!floor || !oldRev || !newRev || !diff || !compliance) {
    return <div className="page">版本不存在（可能楼层已删除）。<Link to="/">返回首页</Link></div>;
  }

  const set = (ids: string[]): Set<string> => new Set(ids);
  // 左（旧版）：删除=红、修改=橙；新增图元在旧图不存在
  const oldMarks: PlanDiffMarks = {
    removedRoomIds: set(diff.removedRoomIds),
    changedRoomIds: set(diff.changedRoomIds),
    removedFacilityIds: set(diff.removedFacilityIds),
    changedFacilityIds: set(diff.changedFacilityIds),
  };
  // 右（新版）：新增=绿、修改=橙；删除图元在新图不存在
  const newMarks: PlanDiffMarks = {
    addedRoomIds: set(diff.addedRoomIds),
    changedRoomIds: set(diff.changedRoomIds),
    addedFacilityIds: set(diff.addedFacilityIds),
    changedFacilityIds: set(diff.changedFacilityIds),
  };

  // 两图任一张上拖动/滚轮，视野一起变
  const onPanDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 && e.pointerType !== 'touch') return;
    const p = mmFromEvent(e.currentTarget, view, e);
    const start = { cx: view.cx, cy: view.cy, mx: p.x, my: p.y };
    e.currentTarget.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const q = mmFromEvent(e.currentTarget, view, ev);
      setView((v) => ({ ...v, cx: start.cx + start.mx - q.x, cy: start.cy + start.my - q.y }));
    };
    const up = () => {
      e.currentTarget.removeEventListener('pointermove', move);
      e.currentTarget.removeEventListener('pointerup', up);
    };
    e.currentTarget.addEventListener('pointermove', move);
    e.currentTarget.addEventListener('pointerup', up);
  };
  const onWheel = (e: React.WheelEvent<SVGSVGElement>) => setView((v) => wheelZoom(v, e, e.currentTarget));

  const latestSeq = revisions[revisions.length - 1].seq;
  const om = oldRev.metrics;
  const nm = newRev.metrics;
  const rulesChanged =
    oldRev.rules.version !== newRev.rules.version ||
    oldRev.rules.maxTravelDistanceM !== newRev.rules.maxTravelDistanceM ||
    oldRev.rules.deadEndDistanceM !== newRev.rules.deadEndDistanceM ||
    oldRev.rules.extinguisherRadiusM !== newRev.rules.extinguisherRadiusM;

  return (
    <div className="page diffpage" style={{ maxWidth: 'none' }}>
      <div className="crumb">
        <Link to="/">{building?.name ?? '建筑'}</Link> / <Link to={`/floor/${floorId}`}>{floorLabel(floor.level)} 层</Link> /{' '}
        <Link to={`/floor/${floorId}/history`}>版本历史</Link> / 对照 v{oldRev.seq} ↔ v{newRev.seq}
      </div>
      <div className="toolbar" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>
          v{oldRev.seq} → v{newRev.seq} 平面对照
        </h2>
        <div className="toolbar" style={{ margin: 0 }}>
          <button onClick={() => setView((v) => ({ ...v, zoom: Math.min(3, v.zoom * 1.3) }))}>放大</button>
          <button onClick={() => setView((v) => ({ ...v, zoom: Math.max(0.008, v.zoom / 1.3) }))}>缩小</button>
          {newRev.seq !== latestSeq && (
            <button
              onClick={() => {
                if (confirm(`把 v${newRev.seq} 回退为当前平面？\n将新增一版「回退」记录，历史不删除。`)) {
                  restoreRevision(floorId, newRev.id);
                }
              }}
            >
              一键回退 v{newRev.seq} 为当前版
            </button>
          )}
          <Link className="btn" to={`/floor/${floorId}/history`}>返回历史</Link>
        </div>
      </div>

      {/* 两图并排 */}
      <div className="diff-maps">
        <DiffMap
          title={`旧版 v${oldRev.seq} · ${oldRev.kind === 'rollback' ? '回退版' : oldRev.kind === 'baseline' ? '初始版' : '改动版'}`}
          subtitle={`${fmtTime(oldRev.createdAt)} · ${oldRev.summary}`}
          snapshot={oldRev.snapshot}
          marks={oldMarks}
          view={view}
          svgRef={oldSvgRef}
          onPan={onPanDown}
          onWheel={onWheel}
          verdict={oldRev.validation?.pass}
        />
        <DiffMap
          title={`新版 v${newRev.seq} · ${newRev.kind === 'rollback' ? '回退版' : newRev.kind === 'baseline' ? '初始版' : '改动版'}`}
          subtitle={`${fmtTime(newRev.createdAt)} · ${newRev.summary}`}
          snapshot={newRev.snapshot}
          marks={newMarks}
          view={view}
          svgRef={newSvgRef}
          onPan={onPanDown}
          onWheel={onWheel}
          verdict={newRev.validation?.pass}
        />
      </div>
      <div className="diff-legend">
        <span><i className="lg lg-add" /> 新增图元（仅新图，绿色）</span>
        <span><i className="lg lg-del" /> 删除图元（仅旧图，红色）</span>
        <span><i className="lg lg-chg" /> 修改图元（两图都在，橙色虚线/标注）</span>
        <span className="hint">两图视野联动：在任一张图上拖动/滚轮缩放</span>
      </div>

      {/* 指标差 */}
      <h3>指标变化</h3>
      <table className="table metric-table">
        <thead>
          <tr><th>指标</th><th>旧版 v{oldRev.seq}</th><th>新版 v{newRev.seq}</th><th>变化（新−旧）</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>总建筑面积</td>
            <td>{om.areaM2.toFixed(1)}㎡</td>
            <td>{nm.areaM2.toFixed(1)}㎡</td>
            <td>{deltaCell(om.areaM2, nm.areaM2, '㎡')}</td>
          </tr>
          <tr>
            <td>房间数（不含走道）</td>
            <td>{om.roomCount}</td>
            <td>{nm.roomCount}</td>
            <td>{deltaCell(om.roomCount, nm.roomCount, ' 间', 0)}</td>
          </tr>
          <tr>
            <td>安全出口数</td>
            <td>{om.exitCount}</td>
            <td>{nm.exitCount}</td>
            <td>{deltaCell(om.exitCount, nm.exitCount, ' 个', 0)}</td>
          </tr>
          <tr>
            <td>走道中心线总长</td>
            <td>{om.corridorLengthM.toFixed(1)}m</td>
            <td>{nm.corridorLengthM.toFixed(1)}m</td>
            <td>{deltaCell(om.corridorLengthM, nm.corridorLengthM, 'm')}</td>
          </tr>
        </tbody>
      </table>

      {/* 改动明细 */}
      <h3>改动明细（{diff.changes.length} 条）</h3>
      {diff.changes.length === 0 ? (
        <p className="hint">两版平面无差异</p>
      ) : (
        <ul className="changelist changes-box">
          {diff.changes.map((c, i) => (
            <li key={i}>
              <span className="tag">{changeVerb(c.kind)}</span> {c.label}
              {c.detail && <span className="hint"> · {c.detail}</span>}
            </li>
          ))}
        </ul>
      )}

      {/* 合规结论翻转 */}
      <h3>合规结论变化</h3>
      <div className="toolbar">
        <span className={`verdict-pill ${compliance.fromPass ? 'pass' : 'fail'}`}>
          v{oldRev.seq}：{compliance.fromPass ? '合规' : '不合规'}
        </span>
        <span>→</span>
        <span className={`verdict-pill ${compliance.toPass ? 'pass' : 'fail'}`}>
          v{newRev.seq}：{compliance.toPass ? '合规' : '不合规'}
        </span>
        {rulesChanged && (
          <span className="tag warn-tag">
            两版规则也不同：{oldRev.rules.buildingKind} v{oldRev.rules.version} → v{newRev.rules.version}
            （依据：{newRev.rules.source}）
          </span>
        )}
      </div>
      {compliance.flips.length === 0 ? (
        <p className="hint">
          各项合规结论无翻转。检查台账类事项（过期/缺记录/缺陷）随时间变化，不在平面版本对照范围内。
        </p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>条目</th><th>对象</th><th>旧版结论 / 实测 / 当时限值</th><th>新版结论 / 实测 / 当时限值</th>
            </tr>
          </thead>
          <tbody>
            {compliance.flips.map((f) => (
              <tr key={f.key}>
                <td>{COMPLIANCE_TYPE_LABELS[f.type] ?? f.type}</td>
                <td>{f.subjectName}</td>
                <td>
                  <span className={f.from === 'pass' ? 'good' : 'bad'}>
                    {f.from === 'pass' ? '✔ 合格' : '✘ 不合规'}
                  </span>
                  <div className="hint">实测：{f.fromValue}｜限值：{f.fromLimit}（规则 v{oldRev.rules.version}）</div>
                </td>
                <td>
                  <span className={f.to === 'pass' ? 'good' : 'bad'}>
                    {f.to === 'pass' ? '✔ 合格' : '✘ 不合规'}
                  </span>
                  <div className="hint">实测：{f.toValue}｜限值：{f.toLimit}（规则 v{newRev.rules.version}）</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function DiffMap(props: {
  title: string;
  subtitle: string;
  snapshot: FloorRevision['snapshot'];
  marks: PlanDiffMarks;
  view: View;
  svgRef: React.RefObject<SVGSVGElement | null>;
  onPan: (e: React.PointerEvent<SVGSVGElement>) => void;
  onWheel: (e: React.WheelEvent<SVGSVGElement>) => void;
  verdict?: boolean;
}) {
  const { title, subtitle, snapshot, marks, view, svgRef, onPan, onWheel, verdict } = props;
  const f = useMemo(() => floorFromSnapshot(snapshot, 1), [snapshot]);
  return (
    <div className="diff-map">
      <div className="diff-map-head">
        <b>{title}</b>
        {verdict != null && (
          <span className={`verdict-pill ${verdict ? 'pass' : 'fail'}`}>{verdict ? '合规' : '不合规'}</span>
        )}
      </div>
      <div className="hint diff-map-sub">{subtitle}</div>
      <svg
        ref={svgRef as React.Ref<SVGSVGElement>}
        className="canvas diff-svg"
        viewBox={`${view.cx - 450 / view.zoom} ${view.cy - 260 / view.zoom} ${900 / view.zoom} ${520 / view.zoom}`}
        onPointerDown={onPan}
        onWheel={onWheel}
        style={{ touchAction: 'none' }}
      >
        <FloorPlan
          floor={f}
          view={view}
          svgRef={svgRef}
          underlayUrl={null}
          selected={null}
          drag={null}
          dragDelta={{ x: 0, y: 0 }}
          draftPoints={[]}
          draftCursor={null}
          coverageCells={null}
          highlight={null}
          markPt={null}
          diffMarks={marks}
        />
      </svg>
    </div>
  );
}
