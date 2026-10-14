# Service photos: card → image

Generated 14 Oct 2026 from the draft menu in a local test copy (125 "For her" + 123 "For him" cards, 154 distinct) by
`customer/lib/serviceImages.ts` (CF D30). *How* = which rule picked the photo: `exact` name, `men` (him-only
Hair → duo-haircut, beard/moustache/Grooming → for-him), `keyword`, or `category` fallback. An owner-uploaded
photo for a service (Service.images) always wins. Waxing has its own six photos (face, underarm, arms, legs, back,
tools); no card uses a category fallback.

| Category | Audience | Card | Photo (slug) | How |
|---|---|---|---|---|
| Hair | unisex | Blowdry & styling | blow-dry | exact |
| Hair | unisex | hair style | blow-dry | exact |
| Hair | unisex | Basic Head Massage | head-massage | exact |
| Hair | her | Blow dry | blow-dry | exact |
| Hair | unisex | Shampoo (Conditioning, Natural Dry) | blow-dry | exact |
| Hair | her | Blow Dry (Wash, Conditioning, Blow Dry) | blow-dry | exact |
| Hair | her | Baby Girls Hair Cut (Wash, Conditioning) | kids-haircut | exact |
| Hair | her | Hair Cut (Wash, Conditioning, Blow Dry) | haircut | exact |
| Hair | her | Party Hairdo (bun) | braid-bun | exact |
| Hair | unisex | Hair Cut (By Creative Styling) | haircut | exact |
| Hair | her | Hairdo (braid) | braid-bun | exact |
| Hair | unisex | Flat Iron Straightening (Wash, Conditioning) | silky-straight | exact |
| Hair | unisex | Head Massage (Coconut, Olive Oil, Natural Dry) | head-massage | exact |
| Hair | unisex | Open Hair Styling (crimping) | glossy-waves | exact |
| Hair | unisex | Open Hair Styling (curls) | glossy-waves | exact |
| Hair | unisex | Open Hair Styling (waves) | glossy-waves | exact |
| Colour | unisex | Root touchup | root-colour | exact |
| Colour | unisex | Color Remove (Henna, Dye) | root-colour | exact |
| Colour | unisex | Global Highlights Balayage Ombre Baby Light | balayage | exact |
| Treatments | unisex | Split Ends (Wash, Conditioning, Blow Dry) | hair-spa | exact |
| Treatments | her | Hair spa | hair-spa | exact |
| Treatments | her | Keratin | silky-straight | exact |
| Treatments | her | Smoothening | silky-straight | exact |
| Treatments | unisex | Olaplex spa | silky-straight | exact |
| Treatments | her | Botox | silky-straight | exact |
| Treatments | unisex | Silk Therapy/Straight Therapy | silky-straight | exact |
| Treatments | unisex | Nanoplastia | silky-straight | exact |
| Treatments | her | Hair Perming | silky-straight | exact |
| Skin | unisex | Eyebrows | threading-eyebrow | exact |
| Skin | unisex | Bleach Neck | bleach-face | exact |
| Skin | unisex | Bleach Hand/Feet | bleach-body | keyword |
| Skin | unisex | Bleach Face | bleach-face | exact |
| Skin | unisex | Clean-up (Basic) | facial-cleanup | exact |
| Skin | unisex | Bleach Arms | bleach-body | keyword |
| Skin | unisex | Organic Bleach Hand/Feet | bleach-body | keyword |
| Skin | her | Organic Bleach Neck | bleach-face | exact |
| Skin | unisex | Bleach Legs | bleach-body | keyword |
| Skin | unisex | Brightening Cleanup (Paragon) | facial-cleanup | exact |
| Skin | unisex | Dull Skin (For Tan Skin) (Brillare) | detan-mask | exact |
| Skin | unisex | Ruber Mask (De Tan Mask) | detan-mask | exact |
| Skin | unisex | Bleach Back | bleach-body | keyword |
| Skin | unisex | Bleach Stomach | bleach-body | keyword |
| Skin | unisex | Organic Bleach Arms | bleach-body | keyword |
| Skin | unisex | De-tan Cleansing | detan-mask | exact |
| Skin | unisex | Organic Bleach Back | bleach-body | keyword |
| Skin | unisex | Organic Bleach Stomach | bleach-body | keyword |
| Skin | unisex | D-tan facial (paragon) | detan-mask | exact |
| Skin | unisex | Deep Cleaning (For Oily/Dry) (Kanpeki) | facial-cleanup | exact |
| Skin | unisex | Organic Bleach Legs | bleach-body | keyword |
| Skin | unisex | Body Scrub | body-scrub | exact |
| Skin | unisex | D-tan Facial (Brillare) | detan-mask | exact |
| Skin | unisex | Fruit Facial | facial | exact |
| Skin | unisex | Radiant Facial (Lotus Professional) | facial | exact |
| Skin | unisex | Power Brightening (Paragon) | facial | exact |
| Skin | unisex | Pure Vitamin Facial (Paragon) | facial | exact |
| Skin | unisex | Pro Hydra (dry skin) | facial | exact |
| Skin | unisex | Pro Hydra (oily skin) | facial | exact |
| Skin | unisex | Bleach Full Body | bleach-body | keyword |
| Skin | unisex | Body Polishing | body-scrub | exact |
| Skin | unisex | Body Bleach | bleach-body | keyword |
| Skin | unisex | Body Wrap | body-scrub | exact |
| Skin | unisex | Papaya & Marshmallow | body-scrub | exact |
| Skin | unisex | Organic Bleach Full Body | bleach-body | keyword |
| Skin | unisex | Dermasyl Range | facial | exact |
| Skin | unisex | Ginger & Walnut | body-scrub | exact |
| Skin | unisex | Jamaican Sorrel | body-scrub | exact |
| Skin | unisex | Body Polishing + Wrap Combo | body-scrub | exact |
| Skin | unisex | Blanch | facial | exact |
| Skin | unisex | Sensi-Age | facial | exact |
| Skin | unisex | Hydra Facial | facial | exact |
| Skin | unisex | Save The Date (Instant Glow For Bride & Groom) | facial | exact |
| Waxing | her | Forehead (wax) Women | wax-face | exact |
| Waxing | unisex | Chin (wax) | wax-face | exact |
| Waxing | unisex | Nose (wax) | wax-face | exact |
| Waxing | unisex | Upper lips (wax) | wax-face | exact |
| Waxing | unisex | Under arms wax (honey) | wax-underarm | exact |
| Waxing | unisex | Half Arms wax (honey) | wax-arms | exact |
| Waxing | unisex | Side locks (wax) | wax-face | exact |
| Waxing | unisex | Half back wax (rica) | wax-back | exact |
| Waxing | unisex | Under arms wax (rica) | wax-underarm | exact |
| Waxing | unisex | Half Arms wax (rica) | wax-arms | exact |
| Waxing | unisex | Stomach wax (honey) | wax-tools | exact |
| Waxing | unisex | Full Arms wax ( honey) | wax-arms | exact |
| Waxing | unisex | Half legs wax (honey) | wax-legs | exact |
| Waxing | unisex | Back wax (honey) | wax-back | exact |
| Waxing | unisex | Half legs wax (rica) | wax-legs | exact |
| Waxing | unisex | Stomach wax (rica) | wax-tools | exact |
| Waxing | unisex | Full Arms wax (rica) | wax-arms | exact |
| Waxing | unisex | Face Wax | wax-face | exact |
| Waxing | unisex | Back wax (rica) | wax-back | exact |
| Waxing | unisex | Full legs wax (honey) | wax-legs | exact |
| Waxing | unisex | Full legs wax (rica) | wax-legs | exact |
| Waxing | her | Bikini wax (honey) | wax-tools | exact |
| Waxing | her | Bikini wax (rica) | wax-tools | exact |
| Waxing | her | Body wax (excluded bikini) (honey) | wax-tools | exact |
| Threading | unisex | Chin (Thread) | threading-lip | exact |
| Threading | unisex | Forehead ( Thread) | threading-eyebrow | exact |
| Threading | unisex | Upper Lips ( Thread) | threading-lip | exact |
| Threading | unisex | Thread combo | threading-eyebrow | exact |
| Threading | unisex | Threading Full Face | threading-eyebrow | exact |
| Hands & feet | unisex | Foot massage | foot-massage | exact |
| Hands & feet | unisex | Mini Manicure | manicure | exact |
| Hands & feet | unisex | Mini Pedicure | pedicure | exact |
| Hands & feet | unisex | Pedicure | pedicure | exact |
| Hands & feet | unisex | Manicure | manicure | exact |
| Hands & feet | unisex | Premium Manicure | manicure | exact |
| Hands & feet | unisex | Premium Pedicure | pedicure | exact |
| Hands & feet | unisex | Luxury Manicure | manicure | exact |
| Hands & feet | unisex | Luxury Pedicure | pedicure | exact |
| Makeup | her | Saree Draping | saree-draping | exact |
| Makeup | unisex | Dress up Setting | dress-up-setting | exact |
| Makeup | her | Bridal Draping | saree-draping | exact |
| Makeup | her | Basic Party Make-up | soft-glam-makeup | exact |
| Makeup | her | HD Party Make-up | soft-glam-makeup | exact |
| Makeup | her | Basic Engagement Make-up | soft-glam-makeup | exact |
| Makeup | her | Basic Reception Make-up | soft-glam-makeup | exact |
| Makeup | her | Signature Make-up | celebrity-makeup | exact |
| Makeup | her | HD Engagement Make-up | soft-glam-makeup | exact |
| Makeup | her | Celebrity Engagement Make-up | celebrity-makeup | exact |
| Makeup | her | HD Make-up (Reception) | soft-glam-makeup | exact |
| Makeup | her | Signature Engagement Make-up | celebrity-makeup | exact |
| Makeup | her | Celebrity Reception Make-up | celebrity-makeup | exact |
| Makeup | her | Signature Reception Make-up | celebrity-makeup | exact |
| Makeup | her | Basic Bridal Make-up | bridal-makeup | exact |
| Makeup | her | HD Bridal Make-up | bridal-makeup | exact |
| Hair | him | Hair Styling | duo-haircut | men |
| Hair | him | Baby Boy Hair Cut (Styling) | duo-haircut | men |
| Hair | him | Blow Dry (Wash, Conditioning, Blow Dry) | blow-dry | exact |
| Hair | him | Blow dry nd wash | duo-haircut | men |
| Hair | him | Shampoo (Wash Styling) | duo-haircut | men |
| Hair | him | Hair Cut (Creative Styling) | duo-haircut | men |
| Hair | him | Hair Cut (Wash Styling) | duo-haircut | men |
| Colour | him | Global Color | balayage | keyword |
| Colour | him | Men hair colour | root-colour | keyword |
| Colour | him | Highlighting | balayage | keyword |
| Treatments | him | Hair spa | hair-spa | exact |
| Treatments | him | Botox | silky-straight | exact |
| Treatments | him | Keratin | silky-straight | exact |
| Treatments | him | Smoothening | silky-straight | exact |
| Treatments | him | Hair Perming | silky-straight | exact |
| Skin | him | Face Bleach | bleach-face | keyword |
| Skin | him | D-tan | detan-mask | keyword |
| Skin | him | Dtan paragon | detan-mask | keyword |
| Waxing | him | Nose wax (inner) | wax-face | keyword |
| Waxing | him | Nose wax (outer) | wax-face | keyword |
| Waxing | him | Ear wax | wax-face | keyword |
| Waxing | him | Forehead wax | wax-face | keyword |
| Waxing | him | Full Face wax | wax-face | keyword |
| Threading | him | Men thread | threading-eyebrow | keyword |
| Grooming | him | Beard cut | for-him | men |
| Grooming | him | Moustache Pasting (Color) | for-him | men |
| Grooming | him | Beard Trim | for-him | men |
| Grooming | him | Beard Color | for-him | men |
| Grooming | him | Moustache Pasting | for-him | men |

Totals: exact 118, keyword 25, men 11.
