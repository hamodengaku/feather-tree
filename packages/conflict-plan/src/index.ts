/*
 * @feathertree/conflict-plan — Excel のコンフリクトの採り方の規則（決定 34・docs/07）。
 *
 * 依存なし・Node も DOM も使わない純関数。core（書き込み）と renderer（プレビュー・未決定の数・印）の両方が使い、
 * 規則を 1 か所にする（二重に持つと、プレビューと書き込みが食い違う）。
 */

export type {
  BlockReason,
  BlockedTarget,
  BothBlock,
  BothOrder,
  ChoiceMaps,
  ConflictChoices,
  ConflictSide,
  ConflictTargets,
  EffectiveChoice,
} from './types.js';
export { cellKey, choiceMapsOf, hasAnyChoice, isBothOrder, lineKey, toConflictChoices } from './keys.js';
export { TargetIndex } from './targets.js';
export { SheetRules, blockedChoicesOf, unresolvedCount, type BlockedChoice, type BothRange } from './rules.js';
export { planIndexOf, planSheet, type AlignedRows, type PlanRow, type PlanRowKind, type SheetPlan } from './plan.js';
