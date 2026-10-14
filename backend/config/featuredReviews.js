/**
 * @file config/featuredReviews.js
 * @description The starting list of reviews shown on the website while the
 * Google Places feed is off (CF D27). Copied word for word from the salon's
 * own Google Business Profile by the owner's team on 14 Oct 2026.
 *
 * This list is only the default. The owner edits the live list in the staff
 * app (Website Settings → Google rating & reviews). The first save writes it to
 * SiteSettings.reviews.featured, and from then on this file is not read.
 *
 * Rules (CF §13, D27):
 *   - Real reviews only, text exactly as written (typos included). Never edit,
 *     shorten or invent one.
 *   - Full names are stored here and in the database. The public API shows
 *     first name + last initial ("Naman T."), so the website never publishes a
 *     customer's full name.
 *   - `service` is only what Google itself lists under the review.
 */

module.exports = [
  {
    author: "Naman Toor",
    rating: 5,
    text: "I had taken the services from the salon. Had a really good experience. Staff was polite nd professional, service was hygienic, nd I loved the final look.",
    service: null,
  },
  {
    author: "Joban Manzal",
    rating: 5,
    text: "Best salon ever in patiala they are using most good products for hairs and as well as for skin my experience was so best there I visit them 10-15 times",
    service: null,
  },
  {
    author: "Leven Ahuja",
    rating: 5,
    text: "Subal was very polite, patient and left me with a wonder haircut and clean shave",
    service: "Shaving, Haircut",
  },
  {
    author: "Dilpreet Kaur",
    rating: 4,
    text: "The service was very good & the staff was also polite.Loved the professionalism and hygiene.",
    service: "Shampoo & conditioning",
  },
];
