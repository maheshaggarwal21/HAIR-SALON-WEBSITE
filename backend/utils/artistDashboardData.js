/**
 * @file artistDashboardData.js
 * @description Shared data-loading helper for artist dashboard routes.
 */

const Visit = require("../models/Visit");
const {
  buildArtistScopedVisitFilter,
  buildArtistRows,
  filterRowsForArtistName,
} = require("./artistAttribution");

async function fetchArtistScopedRows(query, artistName) {
  const { match, from, to } = buildArtistScopedVisitFilter(query, artistName);
  const visits = await Visit.find(match).lean();
  const artistRows = filterRowsForArtistName(buildArtistRows(visits), artistName);

  return {
    artistRows,
    from,
    to,
  };
}

module.exports = {
  fetchArtistScopedRows,
};
