/**
 * @file sessionUtils.js
 * @description Helpers for invalidating sessions stored via express-session.
 */

/**
 * Destroy all sessions that belong to a specific userId.
 * Works with stores that implement `all` and `destroy` (e.g., connect-mongo).
 * @param {import("express-session").Store} sessionStore
 * @param {string} userId
 * @returns {Promise<number>} number of sessions destroyed
 */
async function invalidateUserSessions(sessionStore, userId) {
  if (!sessionStore || typeof sessionStore.all !== "function" || typeof sessionStore.destroy !== "function") {
    return 0;
  }

  return new Promise((resolve) => {
    sessionStore.all((err, sessions) => {
      if (err || !sessions) return resolve(0);
      const sessionEntries = Object.entries(sessions);
      const targetIds = sessionEntries
        .filter(([, sess]) => sess && sess.userId === userId)
        .map(([sid]) => sid);

      if (!targetIds.length) return resolve(0);

      let completed = 0;
      let destroyed = 0;

      targetIds.forEach((sid) => {
        sessionStore.destroy(sid, (destroyErr) => {
          completed += 1;
          if (!destroyErr) destroyed += 1;
          if (completed === targetIds.length) {
            resolve(destroyed);
          }
        });
      });
    });
  });
}

module.exports = { invalidateUserSessions };
