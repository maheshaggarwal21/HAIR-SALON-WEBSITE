/**
 * @file validateId.js
 * @description Express middleware to validate that :id route params are valid
 *              MongoDB ObjectIds. Returns 400 instead of letting Mongoose throw
 *              an unhandled CastError (which surfaces as a 500).
 */

const mongoose = require("mongoose");

function validateId(req, res, next) {
  if (req.params.id && !mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: "Invalid ID format" });
  }
  next();
}

/**
 * Same check, for a route param that isn't called `id`.
 * Routes in management.js use :userId / :deviceId, so the default export
 * (which only looks at req.params.id) would silently pass everything through.
 *
 * @param {string} name the route param to validate
 * @returns {Function} Express middleware
 */
validateId.param = function (name) {
  return function (req, res, next) {
    const value = req.params[name];
    if (value && !mongoose.Types.ObjectId.isValid(value)) {
      return res.status(400).json({ error: "Invalid ID format" });
    }
    next();
  };
};

module.exports = validateId;
