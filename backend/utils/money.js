/**
 * @file money.js
 * @description Rupee formatting for messages the server writes (quotes,
 * WhatsApp, Telegram). Whole rupees, Indian digit grouping: ₹1,23,456.
 */

const rupees = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`;

module.exports = { rupees };
