# Suite design system

Status: adopted 2026-09-23; component migration updated 2026-09-24. Source of truth is `apps/web/src/styles.css`; this page explains the decisions the stylesheet encodes.

## Direction

Dark only. Surfaces and text come from Catppuccin Mocha. Accents come from Dracula. The two palettes share a purple-leaning base, so the mix reads as one system rather than a theme swap.

## Surfaces

Every layer has a job. Borders sit one step above the surface they sit on. Depth comes from tint, not shadow; the only shadow is the overlay shadow on dialogs and the auth card.

| Token                      | Value                 | Used for                                           |
| -------------------------- | --------------------- | -------------------------------------------------- |
| `--crust`                  | `#11111b`             | Outer frame, auth background, browser theme colour |
| `--mantle`                 | `#181825`             | Sidebar, inputs, nested form panels                |
| `--base`                   | `#1e1e2e`             | Page background                                    |
| `--surface-0`              | `#252538`             | Cards, task rows, popovers, dialogs                |
| `--surface-1`              | `#313244`             | Hover, selection, secondary buttons, chips         |
| `--surface-2`              | `#45475a`             | Pressed states, secondary button hover             |
| `--line` / `--line-strong` | `#2e2e44` / `#3a3a54` | Borders on surface-0 / inputs and controls         |

Text is `--text #e2e6f6`, nudged brighter than Mocha's default so body copy still wins against saturated chips. `--subtext #a6adc8` is secondary copy, `--subtext-2 #7f849c` is metadata and eyebrows.

## Accents, one meaning each

| Token      | Value     | Meaning                                                                            |
| ---------- | --------- | ---------------------------------------------------------------------------------- |
| `--purple` | `#bd93f9` | Primary action, selection, time blocks, focus session frame                        |
| `--pink`   | `#ff79c6` | Now. The current-time line, the live timer, the running focus label. Nothing else. |
| `--cyan`   | `#8be9fd` | Keyboard focus ring, links, informational chips, work calendars                    |
| `--teal`   | `#94e2d5` | Calendar authority: Baikal-owned calendars, planned-time metadata                  |
| `--green`  | `#50fa7b` | Success, sync online, working state, current freshness                             |
| `--orange` | `#ffb86c` | Warning, conflict, overdue, stale freshness, offline                               |
| `--red`    | `#ff5555` | Danger, destructive actions, errors, unavailable                                   |
| `--yellow` | `#f1fa8c` | Unassigned. Stays out of the UI until something earns it.                          |

Tinted fills (`--*-tint`) are the accent at 13 to 14 percent over transparent. Use them for chips, banners, and highlighted rows. Never fill a large area with a full-strength accent.

Calm Day states map to chips: working is green, scheduled break is cyan, unavailable is neutral, finished is purple.

## Type

Inter Variable for text, Atkinson Hyperlegible Mono Variable for anything that is a time, a revision, a token, or a count. Both are self-hosted through Fontsource and imported in `main.tsx`. Mono always uses tabular numerals.

| Step          | Size | Use                                        |
| ------------- | ---- | ------------------------------------------ |
| `--text-2xs`  | 10px | Eyebrows, chips, uppercase field labels    |
| `--text-xs`   | 11px | Hints, metadata                            |
| `--text-sm`   | 12px | Controls, secondary copy, buttons          |
| `--text-base` | 13px | Body, task titles                          |
| `--text-lg`   | 15px | Section headings                           |
| `--text-xl`   | 18px | Auth headings                              |
| `--text-2xl`  | 22px | Page titles, weight 650, tracking -0.015em |

## Shape and density

Density is tight. Controls are 30px tall. Task rows have 9px vertical padding. Radius is 5px on controls, 8px on rows and nested panels, 12px on cards.

## Component rules

- Pages use `PageHeader`, `Card`, `SectionHeading`, and `EmptyState`; controls use the primitives in `components/ui`.
- Use `Button` variants for primary, secondary, ghost, and destructive actions. Set `type="button"` for actions inside a form that do not submit it.
- `NativeSelect` preserves native form submission. Named `Checkbox` controls inside forms retain their hidden native input for `FormData`.
- Associate each `FieldLabel` with a unique control ID. The shared text-field helper generates IDs independently of the submitted field name.
- Use `Alert` for feedback and `Badge` for compact state labels. Preserve explicit status and alert roles where they convey asynchronous updates.
- Task rows retain their workflow-specific layout and overdue/focus indicators. Remove legacy CSS only after checking its consumers.
- The Planner uses a day, three-day, or week time grid with separate all-day rows and overlap lanes. Each day follows the selected timezone, including DST. Tasks without estimates show an explicit 30-minute placeholder. The grid displays existing scheduling data; it does not add drag-to-reschedule.

## Cascade layers

Everything after the token blocks in the stylesheet lives in `@layer base` (reset, typography, native form controls) or `@layer components` (every class-based rule). Tailwind's utilities layer is declared after both, so a utility class on any element always wins over the global element and class rules. Keep new rules inside one of those two layers; an unlayered rule would silently override every utility in the app.

One exception: the touch block at the end of `styles.css` (issue #117) is in `@layer utilities`, inside `@media (pointer: coarse)`. It gives controls a 44px minimum size and form text 16px on phones and tablets. The primitives set their size with utilities (`h-7`, `text-sm`), so the same rule in the components layer would lose to them. A mouse or trackpad never matches the query, so desktop density is unchanged.

## Phone layout

The viewport is `viewport-fit=cover` with `interactive-widget=resizes-content`. The shell, the top bar, the auth card, dialogs and sheets pad with `env(safe-area-inset-*, 0px)`; the value is 0 in a browser tab. Full-height layout uses `100dvh`, never `100vh`, so it shrinks when the on-screen keyboard opens. At 48rem and below, long titles wrap (`overflow-wrap: anywhere`) and the page padding drops to 0.75rem. `apps/web/src/phone-layout.test.ts` holds the viewport, `100dvh` and inset rules in place.

## shadcn primitives

The primitives in `components/ui` consume the same tokens. There are no `dark:` variants; the app is dark by default through `:root`. Badge gains `success`, `warning`, `info`, `now`, and `calendar` variants that follow the accent table above.

## Out of scope for now

A light variant. Both source palettes are dark-first, and a Latte-style light theme would be a separate piece of work with its own contrast pass.
