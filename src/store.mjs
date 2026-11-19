import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const platforms = new Set(['xhs', 'douyin', 'channels']);
const nonempty = v => typeof v === 'string' && v.trim().length > 0;
const count = v => Number.isSafeInteger(v) && v >= 0;
const dayOK = v => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v;

// Local-only prototype. It contains no browser launcher or publishing operation.
export function openStore(dbFile, profileRoot, { maxWorkers = 1 } = {}) {
  if (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 2) throw Error('maxWorkers must be 1 or 2');
  if (dbFile !== ':memory:') {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(dbFile)) fs.closeSync(fs.openSync(dbFile, 'wx', 0o600));
  }
  const db = new DatabaseSync(dbFile);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, platform TEXT NOT NULL, label TEXT NOT NULL,
      platform_user_id TEXT, profile_path TEXT NOT NULL UNIQUE,
      UNIQUE(platform, platform_user_id));
    CREATE TABLE IF NOT EXISTS followers (
      account_id TEXT NOT NULL REFERENCES accounts(id), day TEXT NOT NULL,
      total INTEGER NOT NULL CHECK(total>=0), source TEXT NOT NULL,
      PRIMARY KEY(account_id,day));
    CREATE TABLE IF NOT EXISTS works (
      account_id TEXT NOT NULL REFERENCES accounts(id), note_id TEXT NOT NULL,
      title TEXT NOT NULL, url TEXT NOT NULL, PRIMARY KEY(account_id,note_id));
    CREATE TABLE IF NOT EXISTS metrics (
      account_id TEXT NOT NULL, note_id TEXT NOT NULL, day TEXT NOT NULL,
      views INTEGER CHECK(views>=0), likes INTEGER CHECK(likes>=0),
      PRIMARY KEY(account_id,note_id,day),
      FOREIGN KEY(account_id,note_id) REFERENCES works(account_id,note_id));
    CREATE TABLE IF NOT EXISTS runtime_configs (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id), port INTEGER NOT NULL UNIQUE,
      output_path TEXT NOT NULL UNIQUE, database_path TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS account_profiles (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id), platform_user_id TEXT NOT NULL,
      nickname TEXT, red_id TEXT, observed_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS removed_accounts (account_id TEXT PRIMARY KEY REFERENCES accounts(id), removed_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS hidden_placeholders (account_id TEXT PRIMARY KEY REFERENCES accounts(id));
    CREATE TABLE IF NOT EXISTS leases (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id), token TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL);
  `);
  const account = id => {
    const row = db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
    if (!row) throw Error('Unknown account');
    return row;
  };
  const verify = (id, observedUserId) => {
    const row = account(id);
    if (!nonempty(row.platform_user_id) || row.platform_user_id !== observedUserId) throw Error('Account identity mismatch: collection refused');
    return row;
  };
  return {
    close: () => db.close(),
    addAccount({id, platform, label, platformUserId}) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || !platforms.has(platform) || !nonempty(label) || (platformUserId != null && !nonempty(platformUserId))) throw Error('Invalid account');
      const profile = path.join(path.resolve(profileRoot), id);
      db.prepare('INSERT INTO accounts VALUES(?,?,?,?,?)').run(id,platform,label,platformUserId ?? null,profile);
      return account(id);
    },
    hideUnusedPlaceholders() {
      for(const [platform,n,name] of [['xhs',8,'小红书'],['douyin',5,'抖音'],['channels',3,'视频号']])for(let i=1;i<=n;i++){
        const a=db.prepare('SELECT * FROM accounts WHERE id=?').get(`${platform}-${i}`);
        if(!a || a.platform!==platform || a.label!==`${name}账号 ${i}` || a.platform_user_id || fs.existsSync(a.profile_path))continue;
        if(['followers','works','leases'].some(table=>db.prepare(`SELECT 1 FROM ${table} WHERE account_id=?`).get(a.id)))continue;
        db.prepare('INSERT OR IGNORE INTO hidden_placeholders VALUES(?)').run(a.id);
      }
    },
    getAccount: account,
    findByPlatformUser: (platform, userId) => db.prepare('SELECT * FROM accounts WHERE platform=? AND platform_user_id=?').get(platform, userId) ?? null,
    // Display-only profile of the bound platform account. Phone numbers and other personal fields are never stored.
    saveProfile(id, observedUserId, {nickname=null, redId=null}={}) {
      verify(id, observedUserId);
      const clean = v => typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : null;
      db.prepare(`INSERT INTO account_profiles VALUES(?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET
        platform_user_id=excluded.platform_user_id, nickname=excluded.nickname, red_id=excluded.red_id, observed_at=excluded.observed_at`)
        .run(id, observedUserId, clean(nickname), clean(redId), new Date().toISOString());
    },
    bindIdentity(id, observedUserId) {
      const a=account(id);
      if(!nonempty(observedUserId))throw Error('Missing verified identity');
      if(a.platform_user_id && a.platform_user_id!==observedUserId)throw Error('Account already bound: refusing switch');
      db.prepare('UPDATE accounts SET platform_user_id=? WHERE id=?').run(observedUserId,id);
      return account(id);
    },
    runtimeConfig(id) {
      const a=account(id);
      const old=db.prepare('SELECT * FROM runtime_configs WHERE account_id=?').get(id);
      if(old)return {...old,profile_path:a.profile_path};
      db.exec('BEGIN IMMEDIATE');
      try {
        const next=db.prepare('SELECT coalesce(max(port),19399)+1 n FROM runtime_configs').get().n;
        if(next>20000)throw Error('Runtime port allocation exhausted');
        const workspace=path.join(path.dirname(a.profile_path),'workspaces',id);
        db.prepare('INSERT INTO runtime_configs VALUES(?,?,?,?)').run(id,next,path.join(workspace,'output'),path.join(workspace,'account.db'));
        db.exec('COMMIT');
      } catch(e){db.exec('ROLLBACK');throw e;}
      return {...db.prepare('SELECT * FROM runtime_configs WHERE account_id=?').get(id),profile_path:a.profile_path};
    },
    listAccounts: () => db.prepare('SELECT * FROM accounts WHERE id NOT IN (SELECT account_id FROM hidden_placeholders) AND id NOT IN (SELECT account_id FROM removed_accounts) ORDER BY platform,label').all(),
    // "Remove" = hide only. Account row, binding, profile (login state) and all collected data are kept; restorable.
    listRemoved: () => db.prepare(`SELECT a.id,a.platform,a.label,a.platform_user_id,p.nickname,p.red_id,r.removed_at FROM accounts a
      JOIN removed_accounts r ON r.account_id=a.id LEFT JOIN account_profiles p ON p.account_id=a.id ORDER BY r.removed_at DESC`).all(),
    isRemoved: id => !!db.prepare('SELECT 1 FROM removed_accounts WHERE account_id=?').get(id),
    removeAccount(id) { account(id); db.prepare('INSERT OR IGNORE INTO removed_accounts VALUES(?,?)').run(id, new Date().toISOString()); },
    restoreAccount(id) { account(id); return db.prepare('DELETE FROM removed_accounts WHERE account_id=?').run(id).changes === 1; },
    saveFollowers(id, observedUserId, day, total, source='live') {
      verify(id, observedUserId);
      if (!dayOK(day) || !count(total) || !['live','backfill'].includes(source)) throw Error('Invalid followers');
      db.prepare(`INSERT INTO followers VALUES(?,?,?,?) ON CONFLICT(account_id,day) DO UPDATE
        SET total=excluded.total, source=excluded.source
        WHERE followers.source!='live' OR excluded.source='live'`).run(id,day,total,source);
    },
    saveWork(id, observedUserId, {noteId,title,url}) {
      const a=verify(id, observedUserId);
      if (!nonempty(noteId) || !nonempty(title)) throw Error('Invalid work');
      const u=new URL(url);const hosts={xhs:['www.xiaohongshu.com'],douyin:['www.douyin.com'],channels:['channels.weixin.qq.com']};
      if (u.protocol!=='https:' || u.username || u.password || !hosts[a.platform].includes(u.hostname)) throw Error('Invalid work URL');
      db.prepare('INSERT INTO works VALUES(?,?,?,?) ON CONFLICT(account_id,note_id) DO UPDATE SET title=excluded.title,url=excluded.url').run(id,noteId,title,url);
    },
    saveMetrics(id, observedUserId, {noteId,day,views=null,likes=null}) {
      verify(id, observedUserId);
      if (!dayOK(day) || ![views,likes].every(x=>x===null || count(x))) throw Error('Invalid metrics');
      db.prepare('INSERT INTO metrics VALUES(?,?,?,?,?) ON CONFLICT(account_id,note_id,day) DO UPDATE SET views=excluded.views,likes=excluded.likes').run(id,noteId,day,views,likes);
    },
    summary() {
      const rows=db.prepare(`SELECT a.id,a.platform,a.label,a.platform_user_id,p.nickname,p.red_id,f.day,f.total,
        (SELECT count(*) FROM works w WHERE w.account_id=a.id) AS works
        FROM accounts a LEFT JOIN account_profiles p ON p.account_id=a.id AND p.platform_user_id=a.platform_user_id LEFT JOIN followers f ON f.account_id=a.id AND f.day=
        (SELECT max(day) FROM followers WHERE account_id=a.id) WHERE a.id NOT IN (SELECT account_id FROM hidden_placeholders) AND a.id NOT IN (SELECT account_id FROM removed_accounts) ORDER BY a.platform,a.label`).all();
      return {accounts:rows, totalFollowers:rows.filter(r=>r.total!==null).reduce((n,r)=>n+r.total,0),
        accountsWithData:rows.filter(r=>r.total!==null).length,
        note:'Sum of each account latest sample; dates may differ; fans are not deduplicated people'};
    },
    claim(id, {now=Date.now(), ttlMs=300000}={}) {
      account(id);
      if (!Number.isSafeInteger(now) || !Number.isSafeInteger(ttlMs) || ttlMs<1000 || ttlMs>1800000) throw Error('Invalid lease');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM leases WHERE expires_at<=?').run(now);
        if (db.prepare('SELECT 1 FROM leases WHERE account_id=?').get(id) || db.prepare('SELECT count(*) n FROM leases').get().n >= maxWorkers) {
          db.exec('COMMIT'); return null;
        }
        const token=randomUUID();db.prepare('INSERT INTO leases VALUES(?,?,?)').run(id,token,now+ttlMs);db.exec('COMMIT');return token;
      } catch(e) {db.exec('ROLLBACK');throw e;}
    },
    release: token => db.prepare('DELETE FROM leases WHERE token=?').run(token).changes===1,
  };
}
