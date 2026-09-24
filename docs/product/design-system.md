# Suite design system

Status: adopted 2026-09-23. Source of truth is `apps/web/src/styles.css`; this page explains the decisions the stylesheet encodes.

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

- Unclassed `<button>` is the secondary button. `.btn-primary` is purple, `.btn-danger` is outlined red, `.btn-ghost` is text only.
- `<form>` is a grid with a half-rem gap. Inline forms opt out with a class such as `.template-search` or `.offline-capture`.
- `.field` stacks an uppercase label over a control. Labels without a `.field` wrapper stay sentence case.
- `p[role="alert"]` renders as an error message and `p[role="status"]` as quiet secondary copy without needing a class.
- Top-level `<section>` elements inside `.main` or `.today-page` are cards. Sections inside cards are not.
- Task rows use the orange left border for overdue and a purple border plus tinted fill when the row's focus session is running.
- The sidebar marks the active route with a two pixel purple bar and a purple icon.

## Cascade layers

Everything after the token blocks in the stylesheet lives in `@layer base` (reset, typography, native form controls) or `@layer components` (every class-based rule). Tailwind's utilities layer is declared after both, so a utility class on any element always wins over the global element and class rules. Keep new rules inside one of those two layers; an unlayered rule would silently override every utility in the app.

## shadcn primitives

The primitives in `components/ui` consume the same tokens. There are no `dark:` variants; the app is dark by default through `:root`. Badge gains `success`, `warning`, `info`, `now`, and `calendar` variants that follow the accent table above.

## Out of scope for now

A light variant. Both source palettes are dark-first, and a Latte-style light theme would be a separate piece of work with its own contrast pass.
