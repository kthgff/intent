/**
 * registers/ — PRD §15.10 process machinery (wp-153): the DoR engine
 * and the Assumption / Quality-Debt / Delivery-Commitment register
 * rules layered over the store's rows. The DoD per-check evaluator
 * lives in `shepherd/dod.ts` (its pre-wp-153 home) — re-exported here
 * so callers get one import surface.
 */
export * from './assumptions.js';
export * from './quality-debt.js';
export * from './commitments.js';
export * from './dor.js';
export { dodCheckStatuses } from '../shepherd/dod.js';
export type { DodCheckStatus } from '../shepherd/dod.js';
