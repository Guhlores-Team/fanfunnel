# FanFunnel — Product Context

## Register
**Split.** Two surfaces, two registers:
- **Brand** (`/`, `/spin/[token]`): the fan-facing prize game + marketing. Design IS the product. Expressive, premium, indulgent.
- **Product** (`/dashboard`, `/admin`, `/login`): the creator/agency control panel. Design SERVES the task. Refined, data-confident, restrained.

## Users & Purpose
- **Fans** (brand surface): an adult-content creator's audience, almost always on a phone, arriving from a link in a DM. They tip the creator, get spins, and spin a wheel where every spin wins and rare drops keep them coming back. Emotion to evoke: anticipation, indulgence, a little thrill.
- **Creators / agency admins** (product surface): build wheels, set prize rarity + stock, mint per-fan links, fulfil won prizes, watch what's working. They want to trust the data and move fast.

## Brand & Personality
Three words: **indulgent, tactile, confident.** Boutique-nightlife energy, not arcade, not corporate SaaS.

## Brand-adaptive
Every creator picks a brand color. It drives the accent across THEIR fan page via a single `--brand` CSS variable (default `#ec4899`). The dashboard stays neutral/refined; brand color tints the wheel + previews.

## Anti-references (what to avoid)
- The purple/pink "AI gradient" base, glassmorphism-on-everything, emoji-as-icons.
- Three identical feature cards; centered-symmetric everything.
- The hero-metric template on the dashboard (big number / small label / gradient accent).
- Generic Inter/system-only type with no character.

## Strategic principles
- Server decides every spin outcome; the browser only animates. Never leak that authority to the client.
- Mobile-first for fans (safe-area, big tap targets, haptics); density-tolerant for creators.
- Each creator's fan page should feel like THEIRS, not FanFunnel's.
