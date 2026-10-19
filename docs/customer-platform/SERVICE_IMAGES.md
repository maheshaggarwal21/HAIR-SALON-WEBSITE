# Service photos: card → image

Generated 19 Oct 2026 from the owner's signed menu (CF D53: 17 groups, 91 services) in a local test copy, by
`customer/lib/serviceImages.ts` (CF D30). One row per card as each tab shows it (*Tab*: her, him, or the merged
Everyone card). *How* = which rule picked the photo: `men` (men's Hair → mens-haircut, beard/moustache/Grooming →
for-him; checked first), `exact` card title, or `keyword`. An owner-uploaded photo for a service (Service.images)
always wins. No card uses a category fallback.

| Category | Audience | Card | Photo (slug) | How | Tab |
|---|---|---|---|---|---|
| Hair | her | Hair services | haircut | exact | her |
| Colour | her | Hair colour | balayage | exact | her |
| Treatments | her | Hair treatments | keratin | exact | her |
| Skin | unisex | Clean-up | facial-cleanup | keyword | her |
| Skin | unisex | Facials | facial | exact | her |
| Skin | her | Bleach | bleach-face | exact | her |
| Waxing | her | Waxing (honey) | wax-legs | exact | her |
| Waxing | her | Waxing (Rica) | wax-arms | exact | her |
| Waxing | her | Face wax | wax-face | exact | her |
| Threading | her | Threading | threading-eyebrow | keyword | her |
| Hands & feet | unisex | Manicure & pedicure | manicure | keyword | her |
| Makeup | her | Make-up | bridal-makeup | exact | her |
| Hair | him | Hair services | mens-haircut | men | him |
| Colour | him | Hair colour | balayage | exact | him |
| Treatments | him | Hair treatments | keratin | exact | him |
| Waxing | him | Waxing & threading | wax-face | exact | him |
| Grooming | him | Beard & moustache | for-him | men | him |
| Hair | unisex | Hair services | haircut | exact | all |
| Colour | unisex | Hair colour | balayage | exact | all |
| Treatments | unisex | Hair treatments | keratin | exact | all |
