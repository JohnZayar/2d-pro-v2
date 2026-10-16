/**
 * sync.js — OFFLINE STUB for 2D Master Offline.
 * There is no server. Local IndexedDB is the source of truth.
 * Every sync operation is a safe no-op so the rest of app.js
 * (written for the online app) keeps working unchanged.
 */
export function isOnline() { return false; }
export async function queueOp() { /* no server to queue for */ }
export async function syncNow() { /* offline */ }
export async function mutate() { /* local DB already updated by caller */ }
export async function repushAll() { /* offline */ }
export async function repairMissingCreated() { /* offline */ }
export function lastPushError() { return null; }
export async function testPushOne() { return { ok: true, offline: true }; }
