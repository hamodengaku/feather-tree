// 汎用の結果型は土台（@feathertree/base-contract）にある。
// アプリ側の import 元を 1 つに保つため、ここから再輸出する。
export { fail, ok } from '@feathertree/base-contract';
export type { ConfirmationDto } from '@feathertree/base-contract';
export * from './contract.js';
