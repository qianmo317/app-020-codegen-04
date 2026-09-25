# 消防疏散图应用 · Fire Evacuation Map (app-020)

数据模型与几何核心：毫米坐标存储；校验全部在浏览器本地完成，**数据不出浏览器**（无任何后端/联网上传），断网可用。

## 开发

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # vitest 单元测试（疏散距离/覆盖/规则/台账/性能）
npm run build    # tsc 类型检查 + vite 构建到 dist/
```

## Docker

```bash
cd app-020
docker compose up -d --build
curl http://localhost:8100/healthz
docker compose down
```

- 多阶段构建：`node:20-alpine` 构建 → `nginx:1.27-alpine`，端口 `8100:80`
- nginx：SPA 回退、哈希资源 immutable、index.html no-cache、gzip、SVG 正确 MIME
- `client_max_body_size` 未配置也无妨：底图与照片仅存浏览器 IndexedDB，不上传

## 说明

- 疏散距离沿**走道路径**计算（Dijkstra，栅格 0.25m），不是直线距离；房间内取「最远点 → 房间门」直线段
- 灭火器覆盖用 0.5m 栅格采样近似，未覆盖面积 > max(2㎡, 5%) 判不合规
- 校验结果保存时记录当时使用的规则版本与依据文号，打印报告中可见
- 底图与检查照片压缩（长边 1600）后存 IndexedDB，不出浏览器、不入 git（`.gitignore` 已排除 `underlays/`、`photos/`、`exports/`）

## 楼层版本与对照

- 每次平面改动（画/挪/删房间、加/挪/删出口与设施、改名称/用途/人数）自动存一版；名称等连续属性编辑 10 秒内并入同一版，检查台账与灭火器规格改动不建版
- 每版写清改了什么（挪动墙、加房间、换出口……）、四项指标（总面积、房间数、出口数、走道中心线长度）与当时的规则集、校验结果
- 「版本对照」任选两版并排看图：新增图元绿色、删除图元红色、移动/变形图元橙色虚线；指标逐项给出新−旧差值；合规条目按「类型+房间/设施」配对，列出合格↔不合规翻转及**两版各自的限值**（规则可能也改过）
- 任意旧版可一键回退为当前平面；回退本身追加一版 `rollback`（注明来源版本、同样写清明细），历史永不删除；回退即时校验，检查台账跟随保留
- 旧数据（无版本历史的楼层）首次编辑前自动补建「初始版」
