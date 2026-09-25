import { useState } from 'react';
import type { FloorRevision } from '../model';
import { restoreRevision, useStore } from '../store/store';
import { floorLabel } from '../store/id';
import { changeVerb } from '../lib/history';
import { Link } from '../router';

const KIND_LABELS: Record<FloorRevision['kind'], string> = {
  baseline: '初始版',
  edit: '改动',
  rollback: '回退',
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const p2 = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

export function HistoryPage({ floorId }: { floorId: string }) {
  const floor = useStore((s) => s.floors[floorId]);
  const building = useStore((s) => s.buildings.find((b) => b.id === floor?.buildingId));
  const revisions = floor?.revisions ?? [];
  const [pickA, setPickA] = useState<string>('');
  const [pickB, setPickB] = useState<string>('');
  // 默认勾选「最新版 vs 上一版」；仅在两个槽位失效时校正，不覆盖用户选择
  const valid = new Set(revisions.map((r) => r.id));
  const fallbackA = revisions[Math.max(0, revisions.length - 2)]?.id ?? '';
  const fallbackB = revisions[revisions.length - 1]?.id ?? '';
  const aId = valid.has(pickA) ? pickA : fallbackA;
  const bId = valid.has(pickB) ? pickB : fallbackB;

  if (!floor) return <div className="page">楼层不存在。<Link to="/">返回首页</Link></div>;

  const revById = new Map(revisions.map((r) => [r.id, r]));
  const a = revById.get(aId);
  const b = revById.get(bId);
  const compareHref = a && b ? `/floor/${floorId}/diff/${a.id}/${b.id}` : undefined;

  return (
    <div className="page" style={{ maxWidth: 1080 }}>
      <div className="crumb">
        <Link to="/">{building?.name ?? '建筑'}</Link> / <Link to={`/floor/${floorId}`}>{floorLabel(floor.level)} 层</Link> / 版本历史
      </div>
      <div className="toolbar" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{floorLabel(floor.level)} 层 · 版本历史（共 {revisions.length} 版）</h2>
        <Link className="btn" to={`/floor/${floorId}`}>返回编辑器</Link>
      </div>
      <p className="hint">
        每次平面改动自动存一版，历史永不删除；回退旧版本身也会新增一版。勾选任意两版后点「并排对照」查看差异。
      </p>

      <div className="toolbar">
        <button
          disabled={!a || !b || a.id === b.id}
          onClick={() => compareHref && (window.location.hash = `#${compareHref}`)}
        >
          并排对照所选两版
        </button>
        {a && b && a.id !== b.id && (
          <span className="hint">
            已选 v{Math.min(a.seq, b.seq)}（旧）与 v{Math.max(a.seq, b.seq)}（新）
          </span>
        )}
      </div>

      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 40 }}>旧</th>
            <th style={{ width: 40 }}>新</th>
            <th>版本</th>
            <th>类型</th>
            <th>时间</th>
            <th>改了什么</th>
            <th>面积</th>
            <th>房间</th>
            <th>出口</th>
            <th>走道</th>
            <th>合规</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {[...revisions].reverse().map((r) => (
            <tr key={r.id}>
              <td>
                <input type="radio" name="pickA" checked={aId === r.id} onChange={() => setPickA(r.id)} />
              </td>
              <td>
                <input type="radio" name="pickB" checked={bId === r.id} onChange={() => setPickB(r.id)} />
              </td>
              <td><b>v{r.seq}</b></td>
              <td>
                <span className={`badge ${r.kind === 'rollback' ? 'st-expired' : r.kind === 'baseline' ? 'tag' : 'st-ok'}`}>
                  {KIND_LABELS[r.kind]}
                </span>
                {r.rollbackFromSeq != null && <span className="hint"> → v{r.rollbackFromSeq}</span>}
              </td>
              <td className="hint">{fmtTime(r.createdAt)}</td>
              <td style={{ maxWidth: 280 }}>
                {r.kind === 'baseline' ? (
                  <span className="hint">{r.summary}</span>
                ) : r.changes.length === 0 ? (
                  <span className="hint">{r.summary}</span>
                ) : (
                  <details>
                    <summary>{r.summary}</summary>
                    <ul className="changelist">
                      {r.changes.map((c, i) => (
                        <li key={i}>
                          <span className="tag">{changeVerb(c.kind)}</span> {c.label}
                          {c.detail && <span className="hint"> · {c.detail}</span>}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </td>
              <td>{r.metrics.areaM2.toFixed(1)}㎡</td>
              <td>{r.metrics.roomCount}</td>
              <td>{r.metrics.exitCount}</td>
              <td>{r.metrics.corridorLengthM.toFixed(1)}m</td>
              <td>
                {r.validation ? (
                  <span className={r.validation.pass ? 'good' : 'bad'}>
                    {r.validation.pass ? '合规' : `不合规 · ${r.validation.items.filter((i) => i.severity === 'error').length} 项 error`}
                  </span>
                ) : (
                  <span className="hint">空平面</span>
                )}
                <div className="hint">规则 v{r.rules.version}</div>
              </td>
              <td>
                <button
                  className="ghost"
                  disabled={r.id === revisions[revisions.length - 1]?.id}
                  title={r.id === revisions[revisions.length - 1]?.id ? '当前已是最新版' : '把这一版恢复为当前平面（历史保留）'}
                  onClick={() => {
                    if (confirm(`回退到 v${r.seq}？\n当前平面将被该版覆盖，并新增一版「回退」记录，已有历史不会删除。`)) {
                      restoreRevision(floorId, r.id);
                    }
                  }}
                >
                  回退到此版
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
