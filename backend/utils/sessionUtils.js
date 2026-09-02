/**
 * @file sessionUtils.js
 * @description Helpers for invalidating sessions stored via express-session.
 */

const mongoose = require("mongoose");

/**
 * Destroy all sessions that belong to a specific userId.
 *
 * IMPLEMENTATION NOTE — why this does not use `sessionStore.all()`:
 *
 * connect-mongo's `all(cb)` resolves with a plain ARRAY of deserialised session
 * bodies; the session IDs are discarded before the callback ever sees them.
 * The previous implementation did `Object.entries(sessions)` and treated the
 * array indices as session IDs, so it called `destroy("0")`, `destroy("1")`, …
 * Those calls delete nothing, report no error, and were therefore counted as
 * successes — meaning "force sign-out" and the automatic invalidation on
 * password/permission changes silently did nothing at all.
 *
 * We read the backing collection directly instead, which is the only place the
 * sid (`_id`) and the payload live together.
 *
 * @param {import("express-session").Store} sessionStore
 * @param {string} userId
 * @returns {Promise<number>} number of sessions actually destroyed
 */
async function invalidateUserSessions(sessionStore, userId) {
  const target = String(userId);

  try {
    const collection = await resolveCollection(sessionStore);
    if (!collection) return 0;

    // Small collection (one salon), so read-then-filter is cheap and avoids
    // regex-escaping a user id into a query against a serialised JSON string.
    const docs = await collection
      .find({}, { projection: { _id: 1, session: 1 } })
      .toArray();

    const sids = docs
      .filter((doc) => sessionUserId(doc.session) === target)
      .map((doc) => doc._id);

    if (!sids.length) return 0;

    // Delete through the store when we can, so any store-level bookkeeping and
    // the 'destroy' event still fire; fall back to a direct delete otherwise.
    if (typeof sessionStore?.destroy === "function") {
      await Promise.all(
        sids.map(
          (sid) =>
            new Promise((resolve) => sessionStore.destroy(String(sid), () => resolve()))
        )
      );
    } else {
      await collection.deleteMany({ _id: { $in: sids } });
    }

    return sids.length;
  } catch (err) {
    console.error("[sessionUtils] invalidateUserSessions failed:", err.message);
    return 0;
  }
}

/**
 * connect-mongo keeps the live collection handle on `collectionP`. Prefer it so
 * a custom `collectionName` is honoured; fall back to the default `sessions`
 * collection on the active mongoose connection.
 */
async function resolveCollection(sessionStore) {
  if (sessionStore?.collectionP) {
    try {
      return await sessionStore.collectionP;
    } catch {
      /* fall through to the mongoose handle */
    }
  }
  return mongoose.connection?.db?.collection("sessions") ?? null;
}

/**
 * Pull userId out of a stored session payload.
 * connect-mongo stores it as a JSON string by default, but a custom
 * `transformFunctions` (or a future default change) could hand back an object.
 */
function sessionUserId(session) {
  if (!session) return null;
  if (typeof session === "object") return session.userId ?? null;
  try {
    return JSON.parse(session).userId ?? null;
  } catch {
    return null;
  }
}

module.exports = { invalidateUserSessions };
