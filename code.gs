/* JUS MUSIC - BACKEND (Google Apps Script)
   Users/sessions: Script Properties (same method as Private Chat)
   Songs: Google Drive. Song info: library-index.json inside the music folder. */

const MUSIC_FOLDER_ID = '1X-_WZPRgHKOXs2R0eIoBwUV6nQOhKK6J';
const INVITE_CODE = 'CHANGE-ME';      // people need this code to create an account ('' = open sign-up)
const DEFAULT_ROLE = 'uploader';       // 'user' (listen only) or 'uploader' (listen + upload). First account is always 'admin'.
const MAX_BYTES = 25 * 1024 * 1024;    // max song size
const SESSION_DAYS = 30;
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|opus|flac)$/i;

function doGet() { return json_({ ok: true, app: 'jus Music API' }); }

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const api = { registerAccount, loginAccount, logoutAccount, getCurrentUser, getLibrary, getSong, checkDuplicate, uploadSong, deleteSong };
    if (!api[body.fn]) return json_({ ok: false, message: 'Unknown request' });
    return json_(api[body.fn].apply(null, body.args || []));
  } catch (err) { return json_({ ok: false, message: 'Server error: ' + err }); }
}

/* ---------- ACCOUNTS ---------- */
function registerAccount(username, password, displayName, invite) {
  username = normUser_(username); password = String(password || '');
  displayName = String(displayName || username).replace(/[<>]/g, '').trim().slice(0, 40);
  if (INVITE_CODE && String(invite || '').trim() !== INVITE_CODE) return fail_('Wrong invite code.');
  if (username.length < 3) return fail_('Username must be at least 3 characters.');
  if (password.length < 6) return fail_('Password must be at least 6 characters.');
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const props = PropertiesService.getScriptProperties();
    if (props.getProperty('USER_DATA_' + username)) return fail_('Username already exists.');
    const first = !Object.keys(props.getProperties()).some(k => k.indexOf('USER_DATA_') === 0);
    const salt = token_();
    const user = { userId: Utilities.getUuid(), username, displayName, salt, passwordHash: hash_(password, salt),
                   role: first ? 'admin' : DEFAULT_ROLE, createdAt: new Date().toISOString(), fails: 0, lockUntil: 0 };
    props.setProperty('USER_DATA_' + username, JSON.stringify(user));
    return { ok: true, sessionToken: newSession_(user), user: pub_(user) };
  } finally { lock.releaseLock(); }
}

function loginAccount(username, password) {
  username = normUser_(username);
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty('USER_DATA_' + username);
  if (!raw) return fail_('Incorrect username or password.');
  const user = JSON.parse(raw);
  if (user.lockUntil > Date.now()) return fail_('Too many attempts. Try again in a few minutes.');
  if (hash_(String(password || ''), user.salt) !== user.passwordHash) {
    user.fails = (user.fails || 0) + 1;
    if (user.fails >= 5) { user.lockUntil = Date.now() + 5 * 60000; user.fails = 0; }
    props.setProperty('USER_DATA_' + username, JSON.stringify(user));
    return fail_('Incorrect username or password.');
  }
  user.fails = 0; user.lockUntil = 0;
  props.setProperty('USER_DATA_' + username, JSON.stringify(user));
  cleanSessions_();
  return { ok: true, sessionToken: newSession_(user), user: pub_(user) };
}

function logoutAccount(t) { if (t) PropertiesService.getScriptProperties().deleteProperty('SESSION_DATA_' + t); return { ok: true }; }
function getCurrentUser(t) { const u = userFromSession_(t); return u ? { ok: true, user: pub_(u) } : { ok: false, auth: false }; }

function newSession_(user) {
  const t = token_();
  PropertiesService.getScriptProperties().setProperty('SESSION_DATA_' + t, JSON.stringify({
    username: user.username, expiresAt: Date.now() + SESSION_DAYS * 864e5 }));
  return t;
}
function userFromSession_(t) {
  if (!t) return null;
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty('SESSION_DATA_' + t); if (!raw) return null;
  const s = JSON.parse(raw);
  if (s.expiresAt < Date.now()) { props.deleteProperty('SESSION_DATA_' + t); return null; }
  const u = props.getProperty('USER_DATA_' + s.username);
  return u ? JSON.parse(u) : null;
}
function cleanSessions_() {
  const props = PropertiesService.getScriptProperties(), all = props.getProperties();
  Object.keys(all).forEach(k => {
    if (k.indexOf('SESSION_DATA_') !== 0) return;
    try { if (JSON.parse(all[k]).expiresAt < Date.now()) props.deleteProperty(k); } catch (e) { props.deleteProperty(k); }
  });
}
function pub_(u) { return { userId: u.userId, username: u.username, displayName: u.displayName, role: u.role }; }

/* ---------- LIBRARY ---------- */
function getLibrary(t) {
  const u = userFromSession_(t); if (!u) return authFail_();
  const songs = loadIndex_().map(s => Object.assign({}, s, { canDelete: u.role === 'admin' || s.uploaderId === u.userId }));
  return { ok: true, songs, canUpload: u.role === 'admin' || u.role === 'uploader' };
}

function getSong(t, id) {
  const u = userFromSession_(t); if (!u) return authFail_();
  const song = loadIndex_().find(s => s.id === id);       // only songs listed in the library can be opened
  if (!song) return fail_('Song not found.');
  const blob = DriveApp.getFileById(id).getBlob();
  return { ok: true, base64: Utilities.base64Encode(blob.getBytes()), mimeType: blob.getContentType() || 'audio/mpeg' };
}

function checkDuplicate(t, title, artist, hash) {
  const u = userFromSession_(t); if (!u) return authFail_();
  const d = findDuplicate_(loadIndex_(), title, artist, hash);
  return { ok: true, duplicate: d ? { type: d.type, title: d.song.title, artist: d.song.artist } : null };
}

function uploadSong(t, fileName, mimeType, base64, meta, hash) {
  const u = userFromSession_(t); if (!u) return authFail_();
  if (u.role !== 'admin' && u.role !== 'uploader') return fail_('You do not have upload permission.');
  meta = meta || {};
  const bytes = Utilities.base64Decode(base64 || '');
  if (!bytes.length) return fail_('Empty file.');
  if (bytes.length > MAX_BYTES) return fail_('File is larger than 25 MB.');
  if (!AUDIO_EXT.test(fileName || '')) return fail_('Only audio files are allowed.');
  const title = clean_(meta.title || fileName.replace(/\.[^.]+$/, ''), 120);
  const artist = clean_(meta.artist, 80), genre = clean_(meta.genre, 40), language = clean_(meta.language, 30) || 'Other';
  const realHash = hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes));
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const songs = loadIndex_();
    const d = findDuplicate_(songs, title, artist, realHash);
    if (d) return fail_(d.type === 'exact' ? 'This exact audio file is already in the library.' : 'A song with the same title and artist already exists.');
    const folder = childFolder_(DriveApp.getFolderById(MUSIC_FOLDER_ID), language);
    const file = folder.createFile(Utilities.newBlob(bytes, mimeType || 'audio/mpeg', clean_(fileName, 150)));
    const song = { id: file.getId(), title, artist, language, genre, hash: realHash, uploaderId: u.userId,
                   uploaderName: u.displayName, addedAt: new Date().toISOString() };
    songs.push(song); saveIndex_(songs);
    return { ok: true, song: Object.assign({}, song, { canDelete: true }) };
  } finally { lock.releaseLock(); }
}

function deleteSong(t, id) {
  const u = userFromSession_(t); if (!u) return authFail_();
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const songs = loadIndex_(), song = songs.find(s => s.id === id);
    if (!song) return fail_('Song not found.');
    if (u.role !== 'admin' && song.uploaderId !== u.userId) return fail_('You can only delete songs you uploaded.');
    try { DriveApp.getFileById(id).setTrashed(true); } catch (e) {}
    saveIndex_(songs.filter(s => s.id !== id));
    return { ok: true };
  } finally { lock.releaseLock(); }
}

/* ---------- INDEX (stored in Drive) ---------- */
function loadIndex_() {
  const props = PropertiesService.getScriptProperties(), id = props.getProperty('INDEX_FILE_ID');
  if (id) { try { return JSON.parse(DriveApp.getFileById(id).getBlob().getDataAsString()); } catch (e) {} }
  const songs = scan_(DriveApp.getFolderById(MUSIC_FOLDER_ID), '', []);
  const f = DriveApp.getFolderById(MUSIC_FOLDER_ID).createFile('library-index.json', JSON.stringify(songs), 'application/json');
  props.setProperty('INDEX_FILE_ID', f.getId());
  return songs;
}
function saveIndex_(songs) {
  DriveApp.getFileById(PropertiesService.getScriptProperties().getProperty('INDEX_FILE_ID')).setContent(JSON.stringify(songs));
}
function scan_(folder, lang, out) {           // finds songs already in Drive; top folder name = language
  const files = folder.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    if ((f.getMimeType() || '').indexOf('audio/') === 0 || AUDIO_EXT.test(f.getName()))
      out.push({ id: f.getId(), title: f.getName().replace(/\.[^.]+$/, ''), artist: '', language: lang || 'Other', genre: '',
                 hash: '', uploaderId: '', uploaderName: '', addedAt: f.getDateCreated().toISOString() });
  }
  const subs = folder.getFolders();
  while (subs.hasNext()) { const s = subs.next(); scan_(s, lang || s.getName(), out); }
  return out;
}
/* Run this from the editor after dropping songs into Drive by hand: keeps uploaded info, adds new files */
function rescanLibrary() {
  const old = loadIndex_(), known = {};
  old.forEach(s => known[s.id] = true);
  const added = scan_(DriveApp.getFolderById(MUSIC_FOLDER_ID), '', []).filter(s => !known[s.id]);
  saveIndex_(old.concat(added));
  Logger.log('Added ' + added.length + ' new songs');
}
/* Run this ONCE from the editor: asks Google permissions and builds the first library index */
function setup() { Logger.log('Songs in library: ' + loadIndex_().length); }

/* ---------- HELPERS ---------- */
function findDuplicate_(songs, title, artist, hash) {
  const key = s => (s.title + '|' + (s.artist || '')).toLowerCase().replace(/[^a-z0-9|]/g, '');
  const k = key({ title, artist });
  for (const s of songs) {
    if (hash && s.hash && s.hash === hash) return { type: 'exact', song: s };
    if (key(s) === k) return { type: 'title', song: s };
  }
  return null;
}
function childFolder_(p, name) { const i = p.getFoldersByName(name); return i.hasNext() ? i.next() : p.createFolder(name); }
function clean_(s, n) { return String(s || '').replace(/[<>\\\/:*?"|]/g, '').trim().slice(0, n); }
function normUser_(s) { return String(s || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 30); }
function token_() { return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''); }
function hex_(b) { return b.map(x => ('0' + ((x < 0 ? x + 256 : x)).toString(16)).slice(-2)).join(''); }
function hash_(pw, salt) { return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + pw, Utilities.Charset.UTF_8)); }
function fail_(m) { return { ok: false, message: m }; }
function authFail_() { return { ok: false, auth: false, message: 'Please log in again.' }; }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
