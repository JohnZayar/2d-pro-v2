/**
 * pb.js — OFFLINE STUB for 2D Master Offline.
 * No PocketBase server. Local activation + PIN replaces login.
 * `isLoggedIn()` reflects the local session set by app.js after
 * the PIN is verified.
 */
let _user = null;
let _loggedIn = false;

export function setLocalSession(user) { _user = user; _loggedIn = !!user; }
export function isLoggedIn() { return _loggedIn; }
export function getUser() { return _user; }
export function loadBaseUrl() { /* no server */ }
export function loadAuth() { /* no server */ }
export async function refreshAuth() { return _user; }
export async function logout() { _user = null; _loggedIn = false; }
export function getBaseUrl() { return ''; }
export function getDefaultBaseUrl() { return ''; }
export async function realtimeSubscribe() { return () => {}; }

const _offlineErr = () => { const e = new Error('offline'); e.code = 'OFFLINE'; throw e; };
export async function list() { return _offlineErr(); }
export async function create() { return _offlineErr(); }
export async function update() { return _offlineErr(); }
export async function del() { return _offlineErr(); }
export async function getOne() { return _offlineErr(); }
export async function login() { return _offlineErr(); }
