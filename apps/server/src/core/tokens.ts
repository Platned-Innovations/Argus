import { type DataStore } from '@argus/data';

/** Injection token for the active DataStore (PostgreSQL or MongoDB adapter). */
export const DATA_STORE = Symbol('DATA_STORE');
export type { DataStore };
