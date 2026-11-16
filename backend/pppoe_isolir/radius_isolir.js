/**
 * Ubah profil RADIUS pelanggan (Full RADIUS) tanpa RouterOS API.
 * Utama: radusergroup.groupname; opsional override per-user di radreply (Mikrotik-Group).
 */

const { GROUP_ATTRIBUTE } = require('../radius_group');

async function setRadusergroup(db, username, groupname) {
  const user = String(username || '').trim();
  const group = String(groupname || '').trim();
  if (!user || !group) {
    return { ok: false, error: 'username dan groupname wajib diisi' };
  }

  const [updated] = await db.execute(
    'UPDATE radusergroup SET groupname = ? WHERE username = ?',
    [group, user],
  );
  if (updated.affectedRows === 0) {
    await db.execute(
      'INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, 1)',
      [user, group],
    );
  }
  return { ok: true, username: user, groupname: group };
}

async function setRadreplyMikrotikGroup(db, username, groupName) {
  const user = String(username || '').trim();
  if (!user) {
    return { ok: false, error: 'username wajib diisi' };
  }
  await db.execute(
    'DELETE FROM radreply WHERE username = ? AND attribute = ?',
    [user, GROUP_ATTRIBUTE],
  );
  const group = String(groupName || '').trim();
  if (group) {
    await db.execute(
      "INSERT INTO radreply (username, attribute, op, value) VALUES (?, ?, ':=', ?)",
      [user, GROUP_ATTRIBUTE, group],
    );
  }
  return { ok: true, username: user, attribute: GROUP_ATTRIBUTE, value: group || null };
}

/** Isolir: arahkan grup RADIUS ke profil walled garden (mis. profil_isolir). */
async function applyRadiusIsolir(db, username, isolirGroupName) {
  const usergroup = await setRadusergroup(db, username, isolirGroupName);
  if (!usergroup.ok) {
    return usergroup;
  }
  const radreply = await setRadreplyMikrotikGroup(db, username, isolirGroupName);
  return { ok: true, usergroup, radreply };
}

/** Buka isolir: kembalikan grup RADIUS ke profil paket normal. */
async function applyRadiusNormal(db, username, normalGroupName) {
  const usergroup = await setRadusergroup(db, username, normalGroupName);
  if (!usergroup.ok) {
    return usergroup;
  }
  const radreply = await setRadreplyMikrotikGroup(db, username, normalGroupName);
  return { ok: true, usergroup, radreply };
}

module.exports = {
  setRadusergroup,
  setRadreplyMikrotikGroup,
  applyRadiusIsolir,
  applyRadiusNormal,
};
