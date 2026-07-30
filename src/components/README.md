# Components — Untitled UI React

The UI layer is [Untitled UI React](https://www.untitledui.com/react): MIT-licensed,
built on Tailwind v4 and React Aria, which is exactly this template's stack. Components are
**copied into this repo**, not imported from a package — so they are yours to edit, and an
agent can read them.

## Adding a component

```bash
npx untitledui@latest add button input modal -y
```

`-y` is non-interactive and documented by the vendor as the flag for agents and CI. It
resolves each component's dependencies and installs npm packages as needed.

Find one first if the name is unknown:

```bash
npx untitledui@latest search "file upload with drag and drop"
```

Names are not always what you would guess — `badge` does not resolve, `badge-groups` does.
Search rather than assume, or the command silently reports `Skipped 1 unresolved component`.

Already installed: `button`, `input` (with label, hint, file, number, PIN, tags, date),
`modal`, `badge-groups`, `tooltip`, `tags`, `dot-icon`. The payment-card icon set and
`input-payment` were deleted — nothing imported them. `npx untitledui@latest add
input-payment -y` brings them back if a card form ever appears.

## The styling rule

**Component → Tailwind token → nothing else.** In that order, and there is no fourth step.

1. **A component before any styling.** `npx untitledui@latest add <name> -y`. A styled div
   is a worse button than the button, and it has no focus ring.
2. **Tailwind utilities bound to semantic tokens** for everything a component does not cover.
3. **No vanilla CSS.** No new `.css` files, no CSS modules, no styled-components, no
   `<style>` blocks. `src/styles/globals.css`, below the marked divider, is the only place
   project CSS may be added — and needing it usually means a token was missed.

**No raw values, ever.** Not `#0b0d10`, not `rgb(...)`, not `bg-[#111]`, not `text-[13px]`.
An arbitrary value is a colour outside the system, and consistency across the five
screenshots is what "brand cohesion" is scored on.

`style={{...}}` is for runtime-computed values only — a transform from a sensor, a position
from a bounding box. Never a colour or a spacing value.

## The tokens

| Purpose | Class |
|---|---|
| Page background | `bg-primary` |
| Card / raised surface | `bg-secondary`, `bg-tertiary` |
| Body text | `text-primary` |
| Secondary text | `text-tertiary` |
| Error text / surface | `text-error-primary`, `bg-error-primary`, `bg-error-solid` |
| Success | `bg-success-solid`, `text-success-primary` |
| Brand accent | `bg-brand-solid`, `text-brand-primary`, `border-brand` |
| Borders | `border-primary`, `border-secondary` |
| Radius | `rounded-md` … `rounded-xl`, `rounded-full` |
| Type scale | `text-sm`, `text-md`, `text-lg`, `text-display-xs` … `text-display-xl` |

The full list is `src/styles/theme.css`. **Do not edit that file** — re-run
`npx untitledui@latest upgrade` instead. If a token is genuinely missing, add it to `@theme`
in `src/styles/globals.css` below the divider and then use it by name; do not inline the
value at the call site.

## Dark mode

Toggled by the `.dark-mode` class on a root element, not by `prefers-color-scheme`. Every
token above resolves correctly in both.

## Two things that will otherwise cost time

**The editor may run a newer TypeScript than the project.** Cursor bundles its own language
service — here it is TS 6 while `package.json` pins 5.9. A red squiggle the CLI does not
reproduce is usually that gap, not a real break. Reproduce it before chasing it:

```bash
npx --yes -p typescript@6 tsc -p tsconfig.json
```

Verified: the whole project, Untitled UI included, typechecks clean on both 5.9 and 6.0.

**"Cannot find type definition file for 'node'" is almost always a stale TS server.**
`@types/node` is installed and both configs pass on the command line. Command Palette →
*TypeScript: Restart TS Server*.


**`noUnusedLocals` is off in `tsconfig.json`.** Vendored components import `React` without
using it, and with the flag on, `npm run build` fails on a file nobody on the team wrote.
Leave it off.

**There is one CSS entry: `src/styles/globals.css`.** It imports Tailwind, the theme and the
typography plugin. `src/index.css` does not exist — a second `@import "tailwindcss"` would
ship the framework twice and give two competing `@theme` blocks.

## Where kit modules fit

`kit/ui-states` brings the async-state discriminated union — loading, error, empty,
unsupported, success — which is the discipline the judging pipeline rewards most.

Kit modules ship their own `.css` (`states.css`, `camera.css`, `mic.css`, `overlay.css`,
`filedrop.css`) so they work standalone outside this template. **They are vendored: leave
them alone, do not add rules to them, and do not copy the pattern for new code.** Bridge
`--ui-*` to the design system once, as that module's README describes, so the two palettes
cannot drift apart in the screenshots.
