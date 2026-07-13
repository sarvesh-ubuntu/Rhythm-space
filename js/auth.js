/**
 * Rhythm space — Auth  |  auth.js
 *
 * A small local account system: users and sessions live in this browser's
 * localStorage. There is no server, so this is NOT secure storage — treat
 * it as a placeholder that makes "signed in as someone" a real, working
 * concept in the app today.
 *
 * ─── SWAPPING IN FIREBASE LATER ──────────────────────────────────────────
 * This module deliberately exposes the same *shape* Firebase's modular Auth
 * SDK does, so every other file (login.html, dashboard.html, index.html,
 * app.js) can stay unchanged when the backend changes:
 *
 *   window.RymAuth.signUp(email, password, displayName)
 *     ≈ createUserWithEmailAndPassword(auth, email, password)
 *       + updateProfile(cred.user, { displayName })
 *
 *   window.RymAuth.signIn(email, password)
 *     ≈ signInWithEmailAndPassword(auth, email, password)
 *
 *   window.RymAuth.signOut()
 *     ≈ signOut(auth)
 *
 *   window.RymAuth.onAuthStateChanged(callback)
 *     ≈ onAuthStateChanged(auth, callback)
 *     Fires immediately with the current user (or null), then again on
 *     every sign-in/sign-out — same contract Firebase uses.
 *
 *   window.RymAuth.getCurrentUser()
 *     ≈ auth.currentUser
 *
 * The returned "user" object below is a plain
 *   { uid, email, displayName, createdAt }
 * which is a subset of firebase.User — every field on it is also a field
 * on a real Firebase user, so `user.uid` / `user.email` / `user.displayName`
 * keep working unmodified after the swap.
 *
 * To actually swap: add the Firebase SDK, initialize an `auth` instance,
 * and replace the body of each function below with the Firebase call it's
 * commented with above. Nothing outside this file needs to change.
 * ──────────────────────────────────────────────────────────────────────
 */
'use strict';

window.RymAuth = (() => {

  const USERS_KEY   = 'rymspace.users.v1';     // { [uid]: { uid, email, passHash, displayName, createdAt } }
  const SESSION_KEY  = 'rymspace.session.v1';   // { uid }

  let currentUser = null;
  const listeners = [];

  // ── Storage helpers ─────────────────────────────────────────────

  function _loadUsers() {
    try {
      const raw = localStorage.getItem(USERS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (_) {
      return {};
    }
  }

  function _saveUsers(users) {
    localStorage.setItem(USERS_KEY, JSON.stringify(users));
  }

  function _findByEmail(users, email) {
    const norm = String(email || '').trim().toLowerCase();
    return Object.values(users).find(u => u.email === norm) || null;
  }

  // NOT cryptographically secure — there is no server here to keep a real
  // secret away from. This exists only so a password isn't sitting in
  // localStorage in plain text during local development. Firebase Auth
  // handles real password hashing/storage server-side; this function goes
  // away entirely once that swap happens.
  function _weakHash(str) {
    let h = 0;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
      h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    }
    return 'h' + (h >>> 0).toString(36) + s.length;
  }

  function _uid() {
    return 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function _publicUser(rec) {
    if (!rec) return null;
    return {
      uid:         rec.uid,
      email:       rec.email,
      displayName: rec.displayName || rec.email.split('@')[0],
      createdAt:   rec.createdAt
    };
  }

  function _notify() {
    listeners.forEach(cb => {
      try { cb(currentUser); } catch (err) { console.error('rhythm space: auth listener error', err); }
    });
  }

  function _restoreSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return;
      const { uid } = JSON.parse(raw);
      const users = _loadUsers();
      const rec = users[uid];
      currentUser = rec ? _publicUser(rec) : null;
      if (!rec) localStorage.removeItem(SESSION_KEY);
    } catch (_) {
      currentUser = null;
    }
  }

  // ── Public API ───────────────────────────────────────────────────

  /**
   * Subscribe to auth state. Fires immediately with the current user
   * (or null), then again on every sign-in/sign-out. Returns an
   * unsubscribe function — same contract as Firebase's onAuthStateChanged.
   */
  function onAuthStateChanged(cb) {
    listeners.push(cb);
    try { cb(currentUser); } catch (err) { console.error('rhythm space: auth listener error', err); }
    return () => {
      const i = listeners.indexOf(cb);
      if (i !== -1) listeners.splice(i, 1);
    };
  }

  function getCurrentUser() {
    return currentUser;
  }

  /** Create a new local account and sign in as it. */
  async function signUp(email, password, displayName) {
    const norm = String(email || '').trim().toLowerCase();
    if (!norm || !norm.includes('@')) throw new Error('Enter a valid email address.');
    if (!password || password.length < 6) throw new Error('Password must be at least 6 characters.');

    const users = _loadUsers();
    if (_findByEmail(users, norm)) throw new Error('An account with that email already exists.');

    const uid = _uid();
    const rec = {
      uid,
      email: norm,
      passHash: _weakHash(password),
      displayName: (displayName || '').trim() || norm.split('@')[0],
      createdAt: Date.now()
    };
    users[uid] = rec;
    _saveUsers(users);

    localStorage.setItem(SESSION_KEY, JSON.stringify({ uid }));
    currentUser = _publicUser(rec);
    _notify();
    return currentUser;
  }

  /** Sign in to an existing local account. */
  async function signIn(email, password) {
    const users = _loadUsers();
    const rec = _findByEmail(users, email);
    if (!rec || rec.passHash !== _weakHash(password)) {
      throw new Error('Incorrect email or password.');
    }
    localStorage.setItem(SESSION_KEY, JSON.stringify({ uid: rec.uid }));
    currentUser = _publicUser(rec);
    _notify();
    return currentUser;
  }

  function signOut() {
    localStorage.removeItem(SESSION_KEY);
    currentUser = null;
    _notify();
  }

  _restoreSession();

  return {
    onAuthStateChanged,
    getCurrentUser,
    signUp,
    signIn,
    signOut,
    get currentUser() { return currentUser; }
  };
})();
