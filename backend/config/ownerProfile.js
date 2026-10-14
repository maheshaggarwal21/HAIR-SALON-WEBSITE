/**
 * @file config/ownerProfile.js
 * @description Starting "Meet the owner" content for the home page (CF D32).
 * Used until the owner saves their own in Website Settings → Meet the owner;
 * after that SiteSettings.owner wins field by field.
 *
 * DRAFT for the owner to confirm: the text says only what the site already
 * stands for (honest advice, real prices, a trained team). No years, awards or
 * training claims are invented here; add real ones in Website Settings.
 */

module.exports = {
  name: "Ajit Singh",
  title: "Founder & owner, The Experts",
  bio:
    "Ajit Singh founded The Experts on Sirhind–Patiala Road with one idea: everyone in Patiala deserves honest advice, clear prices and skilled hands, whether it's a quick beard trim, a new colour or a bridal look.\n\n" +
    "He leads a team of stylists, colourists, skin specialists and makeup artists, and sets the standard for how every client is welcomed, consulted and looked after. Planning a big change or a wedding? Ask for him at the desk or on WhatsApp.",
  // Static file shipped with the customer site (customer/public/images/owner/); the
  // owner can replace it by uploading a photo in Website Settings.
  photo: "/images/owner/ajit-singh.webp",
};
