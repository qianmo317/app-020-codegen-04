/** 全局数据模型 —— 坐标一律为毫米（mm），距离限值/实测为米（m） */
export type Pt = { x: number; y: number };

export type RoomUsage = 'office' | 'retail' | 'storage' | 'ward' | 'corridor' | 'other';

export type Room = {
  id: string;
  polygon: Pt[];
  name: string;
  usage: RoomUsage;
  areaM2: number;
  occupants?: number;
};

export type FacilityKind =
  | 'extinguisher'
  | 'hydrant'
  | 'exit_sign'
  | 'emergency_light'
  | 'exit'
  | 'sprinkler';

export type CheckStatus = 'ok' | 'low_pressure' | 'expired' | 'damaged' | 'missing';

export type CheckRecord = {
  date: string; // YYYY-MM-DD
  status: CheckStatus;
  photoKey?: string; // IndexedDB key，照片仅存本地
  note?: string;
};

export type Facility = {
  id: string;
  kind: FacilityKind;
  x: number; // mm
  y: number; // mm
  code: string; // 楼层-类型-序号，如 3F-EX-01
  spec?: {
    extType?: 'dry_powder' | 'co2' | 'water';
    weightKg?: number;
  };
  checks: CheckRecord[];
};

/**
 * 楼层平面快照：版本历史的最小记录单位。
 * 只包含平面本身与设施检查台账（回退恢复已删除设施时台账也能找回），
 * 不含底图、标记——照片/底图只存本地 IndexedDB，不属于平面改动。
 */
export type PlanSnapshot = {
  rooms: Room[];
  facilities: Facility[];
  exits: string[];
};

/** 对照时关心的四项汇总指标（面积含全部房间，走道长度按走道骨架估算） */
export type FloorMetrics = {
  areaM2: number; // 全部房间面积合计
  roomCount: number; // 非走道房间数
  exitCount: number; // 安全出口设施数
  corridorLengthM: number; // 走道中心线总长（栅格骨架近似，m）
};

/** 变更条目：「改了什么」的人读描述，按类型区分 */
export type PlanChangeKind =
  | 'room_added'
  | 'room_removed'
  | 'room_moved'
  | 'room_reshaped'
  | 'room_renamed'
  | 'room_reused'
  | 'room_occupants'
  | 'exit_added'
  | 'exit_removed'
  | 'exit_moved'
  | 'facility_added'
  | 'facility_removed'
  | 'facility_moved';

export type PlanChange = {
  kind: PlanChangeKind;
  /** 变更主体名称（房间名 / 设施编号），尽量取新版名称，删除时取旧版 */
  label: string;
  /** 主体 id（房间/设施），连续编辑合并时用它追踪同一主体，内部使用 */
  subjectId?: string;
  /** 数值变化（如人数 10→12、移动距离），可选 */
  detail?: string;
};

/** 图元级差异：供对照页在两张图上分别高亮新增/删除/修改 */
export type PlanDiff = {
  addedRoomIds: string[];
  removedRoomIds: string[];
  changedRoomIds: string[]; // 同 id 但形状/位置/用途变化
  addedFacilityIds: string[];
  removedFacilityIds: string[];
  changedFacilityIds: string[];
  changes: PlanChange[];
};

export type RevisionKind = 'baseline' | 'edit' | 'rollback';

/** 一版楼层平面 */
export type FloorRevision = {
  id: string;
  seq: number; // 楼层内单调递增的版本号 v1/v2...
  kind: RevisionKind;
  createdAt: string;
  /** 改动说明（baseline 为建版说明，rollback 注明回退来源） */
  summary: string;
  /** 明细变更条目；baseline 为空 */
  changes: PlanChange[];
  /** 回退来源版本号（kind === 'rollback' 时存在） */
  rollbackFromSeq?: number;
  /** 连续属性编辑（如名称输入）合并为同一版的键，内部使用 */
  coalesceKey?: string;
  snapshot: PlanSnapshot;
  metrics: FloorMetrics;
  /** 建版当时的完整规则集（限值可能改过，合规对照需要两版各自的限值） */
  rules: RuleSet;
  /** 建版当时的校验结果（自动校验完成后回填；无房间/设施时可能为空） */
  validation: ValidationResult | null;
};

export type Underlay = {
  key: string; // IndexedDB key
  wPx: number;
  hPx: number;
  offsetX: number; // mm，底图左上角在图纸坐标中的位置
  offsetY: number;
  scaleMmPerPx: number; // 仅影响底图显示，不影响校验
  opacity: number; // 0~1
  visible: boolean;
};

export type Floor = {
  id: string;
  buildingId: string;
  level: number; // 1,2,3... 地下为 -1,-2
  scaleMmPerUnit: number; // 兼容字段：毫米坐标存储，此值仅影响底图显示
  rooms: Room[];
  facilities: Facility[];
  exits: string[]; // kind === 'exit' 的设施 id
  underlay?: Underlay;
  version: number; // 每次编辑 +1，用于触发校验
  lastValidation?: ValidationResult;
  /** 版本历史（每次平面改动追加一版，永不删除；旧数据无此字段时首次编辑前补建） */
  revisions?: FloorRevision[];
};

export type BuildingKind = 'office' | 'retail' | 'factory' | 'school';

export type Building = {
  id: string;
  name: string;
  kind: BuildingKind;
  floors: string[];
  createdAt: string;
};

export type RuleSet = {
  buildingKind: BuildingKind;
  maxTravelDistanceM: number;
  deadEndDistanceM: number;
  extinguisherRadiusM: number;
  exitMinAreaM2: number; // 超过此面积需 ≥2 个安全出口
  exitMaxOccupants: number; // 超过此人数需 ≥2 个安全出口
  source: string; // 依据文号，报告中打印
  version: number; // 规则版本，修改即 +1，校验结果记录当时版本
};

export type ValidationSeverity = 'error' | 'warning';

export type ValidationItem = {
  severity: ValidationSeverity;
  type: string;
  message: string;
  roomId?: string;
  facilityId?: string;
  point?: Pt; // 图纸定位点 mm
  value?: number; // 实测值（m / m²）
  limit?: number;
};

export type ValidationResult = {
  checkedAt: string;
  pass: boolean;
  items: ValidationItem[];
  travelWorstM: number | null;
  travelWorstPoint?: Pt | null;
  deadEndM: number | null;
  coverage: { uncoveredM2: number; totalM2: number; pass: boolean; samples: Pt[] } | null;
  exits: { present: number; required: number };
  rulesSnapshot: {
    buildingKind: BuildingKind;
    version: number;
    source: string;
    maxTravelDistanceM: number;
    deadEndDistanceM: number;
    extinguisherRadiusM: number;
    exitMinAreaM2: number;
    exitMaxOccupants: number;
  };
};

export const FACILITY_LABELS: Record<FacilityKind, string> = {
  extinguisher: '灭火器',
  hydrant: '消火栓',
  exit_sign: '疏散指示灯',
  emergency_light: '应急照明',
  exit: '安全出口',
  sprinkler: '喷淋',
};

export const FACILITY_CODES: Record<FacilityKind, string> = {
  extinguisher: 'EX',
  hydrant: 'HY',
  exit_sign: 'ES',
  emergency_light: 'EL',
  exit: 'EXIT',
  sprinkler: 'SP',
};

export const USAGE_LABELS: Record<RoomUsage, string> = {
  office: '办公',
  retail: '商业',
  storage: '仓库',
  ward: '病房',
  corridor: '走道',
  other: '其他',
};
