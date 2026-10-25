/**
 * @file db.js
 * @description Singleton MongoDB connection manager for serverless environments.
 *
 * On platforms like Vercel, each invocation may cold-start a new process.
 * This module caches the connection promise so that concurrent requests
 * share the same connection rather than opening duplicates.
 *
 * ── Why the cached promise is invalidated on disconnect ──────────────────────
 * The cache used to be cleared only when a connection ATTEMPT failed. If a
 * connection succeeded and later dropped — Atlas failover, idle socket timeout,
 * a network blip — `connectionPromise` stayed a resolved promise while
 * mongoose.readyState went to 0. connectDB() then returned that stale promise
 * immediately, reported success, and handed the caller a dead client. Every
 * query after that threw MongoNotConnectedError, and because nothing ever reset
 * the promise, the process stayed broken until the container was recycled.
 *
 * Staff saw this as "Internal server error during permission check" appearing
 * out of nowhere and sticking around. The listeners below are what let a
 * dropped connection heal itself on the next request.
 */

const mongoose = require("mongoose");

/**
 * Connections each server instance may hold open to Atlas.
 *
 * Mongoose's own default is 100 per process. On Vercel every concurrent invocation can be its own
 * instance, so a burst of visitors (a festival ad going live) opens instances x 100 connections and
 * can hit the Atlas limit, after which every request fails, staff app included. One request needs
 * only a handful at a time (a few parallel queries, one transaction), so 10 is plenty.
 * MONGODB_MAX_POOL_SIZE adjusts it (whole number, 1 to 50).
 */
const DEFAULT_MAX_POOL_SIZE = 10;
const MAX_POOL_SIZE_LIMIT = 50;

/** The options passed to mongoose.connect(). Pure, so it can be tested. */
function connectionOptions(env = process.env) {
  const raw = String(env.MONGODB_MAX_POOL_SIZE ?? "").trim();
  const asked = /^\d+$/.test(raw) ? Number(raw) : NaN;
  const maxPoolSize = asked >= 1 ? Math.min(asked, MAX_POOL_SIZE_LIMIT) : DEFAULT_MAX_POOL_SIZE;
  return {
    serverSelectionTimeoutMS: 8000, // Fail fast on cold-start instead of 30 s
    socketTimeoutMS: 45000,
    maxPoolSize,
  };
}

/** Cached connection promise — shared across requests within one process. */
let connectionPromise = null;

// readyState: 0 disconnected · 1 connected · 2 connecting · 3 disconnecting
const DISCONNECTED = 0;
const CONNECTED = 1;
const CONNECTING = 2;
const DISCONNECTING = 3;

// Registered once at module load. Without these, a dead connection is
// indistinguishable from a live one as far as connectDB() is concerned.
mongoose.connection.on("disconnected", () => {
  if (connectionPromise) console.warn("[db] connection lost — will reconnect on next request");
  connectionPromise = null;
});
mongoose.connection.on("error", (err) => {
  console.error("[db] connection error:", err.message);
  connectionPromise = null;
});

/**
 * Connect to MongoDB Atlas (or local) using the MONGODB_URI env var.
 * Safe to call repeatedly — returns immediately if already connected, and
 * reconnects if a previous connection has since dropped.
 *
 * @returns {Promise<void>}
 * @throws {Error} If MONGODB_URI is missing or the connection fails.
 */
async function connectDB() {
  if (mongoose.connection.readyState === CONNECTED) return;

  // A close is in progress — let it finish before opening a new one.
  if (mongoose.connection.readyState === DISCONNECTING) {
    await new Promise((resolve) =>
      mongoose.connection.once("disconnected", resolve)
    );
  }

  // A connect is genuinely in flight: share it rather than opening a second.
  if (mongoose.connection.readyState === CONNECTING && connectionPromise) {
    return connectionPromise;
  }

  // Belt and braces: if we are disconnected, any cached promise describes a
  // connection that no longer exists. Awaiting it would resolve instantly and
  // return a dead client. The listeners above normally clear it; this covers
  // any path that drops the connection without emitting.
  if (mongoose.connection.readyState === DISCONNECTED) {
    connectionPromise = null;
  }

  if (connectionPromise) return connectionPromise;

  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI environment variable is not set");
  }

  console.log("[db] Connecting to MongoDB…");

  connectionPromise = mongoose
    .connect(process.env.MONGODB_URI, connectionOptions())
    .then(() => {
      console.log("[db] MongoDB connected successfully");
    })
    .catch((err) => {
      console.error("[db] MongoDB connection failed:", err.message);
      connectionPromise = null; // Allow retry on next request
      throw err;
    });

  return connectionPromise;
}

module.exports = connectDB;
module.exports.connectionOptions = connectionOptions;
module.exports.DEFAULT_MAX_POOL_SIZE = DEFAULT_MAX_POOL_SIZE;
