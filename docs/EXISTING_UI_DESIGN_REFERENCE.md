# ExamProctor.ai — Existing UI Design System Reference

> **Generated:** Phase 1 Design System Audit  
> **Source of Truth:** `frontend/src/styles/tokens.css`, `frontend/src/styles/global.css`, `frontend/src/components/layout/AppLayout.module.css`

---

## 1. Visual Design Philosophy: Neo-Brutalism
ExamProctor.ai utilizes a distinctive, high-contrast **Neo-Brutalism** design system rather than generic minimalist SaaS styling. Key characteristics:
- **Warm Cream Surface:** The application background is a warm cream (`#FFF8EE`), not pure white or cold gray.
- **Deep Navy Ink & Borders:** All text, containers, and borders use deep ink navy (`#172554` / `#10204A`) instead of faded grays.
- **Controlled Hard Offset Shadows:** Elements use crisp, blur-free directional drop shadows (e.g. `3px 3px 0 #172554`, `4px 4px 0 #172554`, `6px 6px 0 #172554`).
- **Tactile Micro-interactions:** Buttons and cards lift up (`translateY(-2px)`) on hover and depress (`translate(1px, 1px)`) on click with shadow collapse.
- **Bold Accents:** High-energy primary blue (`#2563EB`), warm orange (`#F97316`), forest green (`#15803D`), amber yellow (`#FACC15`), and crimson red (`#DC2626`).

---

## 2. Design Tokens & CSS Variables (`styles/tokens.css`)

### Color Palette
| Token | Hex Value | Usage |
|-------|-----------|-------|
| `--color-page-bg` | `#FFF8EE` | Warm cream full-page background |
| `--color-surface` | `#FFFFFF` | Primary card and modal background |
| `--color-surface-alt` | `#FFF0D8` | Table row hover, secondary card fill |
| `--color-text-main` | `#172554` | Primary body copy |
| `--color-text-heading` | `#10204A` | Headings, table headers, sidebar base |
| `--color-text-secondary` | `#244A78` | Subtitles, labels, metadata |
| `--color-text-on-dark` | `#FFF8EE` | Text on dark navy backgrounds |
| `--color-text-on-blue` | `#FFFFFF` | Text on primary blue buttons |
| `--color-blue` | `#2563EB` | Primary brand accent |
| `--color-blue-deep` | `#173B8F` | Active states, hover on primary |
| `--color-blue-light` | `#DCEBFF` | Light blue badge & highlight fill |
| `--color-blue-panel` | `#EEF4FF` | Alternating table rows, subtle panels |
| `--color-orange` | `#F97316` | Attention callouts, warning stat cards |
| `--color-orange-light` | `#FFEDD5` | Warning badge fill, light amber fill |
| `--color-green` | `#15803D` | Success states, active indicators |
| `--color-green-light` | `#DCFCE7` | Success badges, green tint panels |
| `--color-yellow` | `#FACC15` | Highlight chips, cautionary notes |
| `--color-yellow-light` | `#FEF3C7` | Caution badge background |
| `--color-red` | `#DC2626` | Destructive actions, violations, critical errors |
| `--color-red-light` | `#FEE2E2` | Error alerts, critical badge fill |
| `--color-border` | `#172554` | Standard neo-brutalist border ink |
| `--color-border-light` | `#BFDBFE` | Subtle inner dividers |
| `--color-focus` | `#2563EB` | Accessible focus-visible ring |

### Typography
- **Font Family:** `'Plus Jakarta Sans', 'Inter', system-ui, sans-serif`
- **Headings (`h1`–`h6`):** Font weight `800` (extra bold) or `700` (bold), line-height `1.25`, color `--color-text-heading`.
  - `h1`: 2rem (32px) / 2.25rem
  - `h2`: 1.625rem (26px)
  - `h3`: 1.375rem (22px)
  - `h4`: 1.125rem (18px)
- **Body & Meta:** Base font size `0.9375rem` (15px), normal weight `400` / medium `500` / semibold `600`.
- **Code / Identifiers:** Monospace (`monospace`), font weight 700 with letter-spacing `0.08em`.

### Borders & Radius
- `--border-thin`: `1px solid var(--color-border)`
- `--border-base`: `2px solid var(--color-border)`
- `--border-thick`: `3px solid var(--color-border)`
- `--radius-sm`: `4px`
- `--radius-md`: `8px`
- `--radius-lg`: `12px`
- `--radius-xl`: `16px`
- `--radius-full`: `9999px`

### Shadows (Zero-Blur Neo-Brutalist Offsets)
- `--shadow-sm`: `3px 3px 0 var(--color-border)`
- `--shadow-md`: `4px 4px 0 var(--color-border)`
- `--shadow-lg`: `6px 6px 0 var(--color-border)`
- `--shadow-blue`: `4px 4px 0 var(--color-blue)`
- `--shadow-orange`: `4px 4px 0 var(--color-orange)`

---

## 3. Existing UI Component Patterns (`styles/global.css`)

### Buttons (`.btn`)
All buttons share `.btn` with border `var(--border-base)`, radius `var(--radius-md)`, and box-shadow `3px 3px 0 var(--color-border)`.
- `.btn-primary`: Blue background (`#2563EB`), white text. Hover: `#173B8F`.
- `.btn-secondary`: White background, navy text. Hover: `#DCEBFF`.
- `.btn-danger`: Red background (`#DC2626`), white text. Hover: `#B91C1C`.
- `.btn-success` / `.btn-green`: Green background (`#16A34A`), white text.
- `.btn-orange` / `.btn-amber`: Amber background (`#F59E0B`), navy text.
- `.btn-ghost`: Transparent background, no border/shadow until hover.
- `.btn-sm`: Compact padding (`5px 10px`), font-size `0.8125rem`.

### Cards (`.card` and `.card-sm`)
- `.card`: Surface `#FFFFFF`, border `2px solid #172554`, border-radius `12px`, box-shadow `4px 4px 0 #172554`, padding `24px`.
- `.statCard`: Centered stat with value `font-size-4xl`, uppercase letter-spaced label, bordered with color-coded offset shadow (`.statBlue`, `.statGreen`, `.statOrange`).

### Badges (`.badge`)
- Pill-shaped (`border-radius: 9999px`), `1.5px solid currentColor`.
- `.badge-blue`: Text `--color-blue`, background `--color-blue-light`.
- `.badge-green`: Text `--color-green`, background `--color-green-light`.
- `.badge-red`: Text `--color-red`, background `--color-red-light`.
- `.badge-orange`: Text `--color-orange`, background `--color-orange-light`.
- `.badge-yellow`: Text `#854D0E`, background `--color-yellow-light`.

### Form Controls (`.form-input`, `.form-select`, `.form-textarea`)
- White surface, `2px solid #172554` border, radius `8px`, `3px 3px 0 var(--color-border)` shadow.
- Focus: `outline: none`, `border-color: var(--color-blue)`, ring `0 0 0 3px var(--color-blue-light)`.

### Tables (`.table-wrapper` + `.data-table`)
- Wrapper: `2px solid #172554` border, radius `12px`, shadow `4px 4px 0 #172554`, overflow-x auto.
- Thead: Solid deep navy `#10204A`, white text, uppercase letter-spaced headers.
- Rows: White alternating with light blue panel (`#EEF4FF`), hover background warm cream (`#FFF0D8`).

### Modals (`.modal-backdrop` + `.modal`)
- Backdrop: `rgba(16, 32, 74, 0.55)` with `backdrop-filter: blur(4px)`.
- Modal Window: White surface, `3px solid #172554` border, radius `16px`, shadow `6px 6px 0 #172554`.
- Header with clear bold title, body with comfortable padding, footer with right-aligned action buttons.

---

## 4. Layout & Navigation Hierarchy
- **Sidebar (`AppLayout.jsx`, `AppLayout.module.css`):**
  - Dark navy (`#10204A`), border-right `3px solid #172554`.
  - Fixed 250px (collapsible to 72px).
  - Brand header with logo + orange dot.
  - Active nav item: Blue fill (`#2563EB`), white text, `2px 2px 0 var(--color-blue-deep)` shadow.
  - Anchored footer: Avatar with orange circle, user name/USN, and distinct solid red logout button (`#DC2626`).
- **Main Viewport:**
  - Cream background (`#FFF8EE`), scrollable, responsive padding (`32px` desktop, `16px` mobile).
  - Preserves standard navigation without nested duplicate sidebars.
