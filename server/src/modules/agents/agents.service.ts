/**
 * agents.service.ts — re-export barrel.
 *
 * The implementation lives in agents.<concern>.ts. This file exists so the
 * controller, the 900-line test suite and every other consumer keep importing
 * from one stable path while the internals stay split by concern.
 */
export * from './agents.types';
export * from './agents.shared';
export * from './agents.roster';
export * from './agents.drift';
export * from './agents.countdown';
export * from './agents.collapse';
export * from './agents.events';
export * from './agents.population';
export * from './agents.graph';
export * from './agents.pulse';
export * from './agents.benchmark';
