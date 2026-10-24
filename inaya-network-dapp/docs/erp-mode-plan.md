# Business Workspace ERP Mode: Plan

Approved 2026-10-24. Requested by a local software house introducing Inaya to a mid-tier company that
expects a classic desktop ERP layout (reference: IDS Astra G2).

## Decisions

- ERP mode is ON by default in the desktop app (inaya-desktop); users can switch back to the current layout.
- On the web the current layout stays the default; ERP mode is an opt-in setting.
- Light only. Two themes: **G2 Classic** (charcoal, deep red, graphite) and **Inaya Brand** (navy, teal).
- Appearance settings live in Settings (admins) and in the title bar's user menu (everyone).
- Everything live in Business Workspace must be reachable in ERP mode. Nothing is rewritten: ERP mode is a
  new frame around the existing screens, permissions and data.
- Industry OS isolation is preserved: an org sees only its own industry OS (`verticalOnly` via
  `isNavItemVisible`, never a copy of that check).

## Batches (each tested before push)

1. **ERP shell**: `src/lib/navigation/erpModules.js` (every view key belongs to exactly one tile), inventory
   and industry-isolation tests, `ErpShell` (title bar, module bar, notice bar, task panel, status bar),
   both themes, Appearance settings, all header features in the title bar.
2. **Core modules connected**: Accounting, Sales, Purchasing, Inventory, People, Tasks, Documents. The task
   panel drives their sections; task links open the existing forms.
3. **All other modules connected**: remaining tabbed screens, including all five industry OSes and their
   own sections, security, IT and admin.
4. **Home and module dashboards**: G2-style Home and an overview per module and industry OS, built only on
   existing APIs.
5. **Desktop feel**: dense data grid on the main lists, right-click actions, keyboard shortcuts, selection
   rules, no website elements, full width.
6. **Native desktop release**: Modules / Window / Help menus, remembered window size and position, local
   loading and offline screens, version 0.2.0 through the existing update channel. Installed and confirmed
   by a human (the assistant's sandbox installs into a hidden folder).

## Rules carried over from earlier SOWs

- View keys never change: the desktop app's `?view=` pop-out windows depend on them.
- The current web layout must be unchanged for anyone not using ERP mode.
- Never run `next dev` and `next build` at the same time (they corrupt `.next`).
