# ADO Visualizer

> An Electron desktop app for visualizing Azure DevOps work items as
> trees, timelines, dependency graphs, sprint kanbans, and richer wiki
> pages with Mermaid support.

[![Build Installers](https://github.com/mgblackwater/azure-devops-visualizer/actions/workflows/build-installer.yml/badge.svg)](https://github.com/mgblackwater/azure-devops-visualizer/actions/workflows/build-installer.yml)
[![Latest release](https://img.shields.io/github/v/release/mgblackwater/azure-devops-visualizer?include_prereleases&display_name=tag)](https://github.com/mgblackwater/azure-devops-visualizer/releases/latest)

**Full feature tour:** <https://mgblackwater.github.io/azure-devops-visualizer/>

## Download

Grab the latest installer from the
[**Releases**](https://github.com/mgblackwater/azure-devops-visualizer/releases/latest)
page.

- **Windows** — download the `*-Setup.exe` (NSIS installer) and run it.
  Creates Start Menu and desktop shortcuts; uninstall via Settings →
  Apps.
- **macOS** — download the `*.dmg` for your CPU
  (`-arm64.dmg` for Apple Silicon, `-x64.dmg` for Intel), mount it,
  drag **ADO Visualizer** to **Applications**.
  - **First launch:** the build is unsigned (no Apple Developer cert),
    so Gatekeeper will refuse on the first try. Right-click
    **ADO Visualizer.app** → **Open** → confirm. macOS only asks
    once. If the app stays quarantined, drop the attribute manually:
    ```bash
    xattr -cr "/Applications/ADO Visualizer.app"
    ```

Older builds and full release notes:
<https://github.com/mgblackwater/azure-devops-visualizer/releases>

---

## About

A custom desktop visualizer for Azure DevOps work items. Built because the
out-of-the-box ADO web UI is heavy on tree/grid views and weak on the things
people actually want to see — timelines, dependency graphs, and mind-maps.

The renderer is a pure React SPA; Electron is the host so we can call the
Azure DevOps REST API directly from the main process (no CORS, no proxy).
The renderer talks to Electron through a tiny typed IPC bridge
(`window.ado.invoke`), so the same UI could be hosted on the web later by
swapping the bridge for a thin proxy — no changes in `src/`.

## Features

- **Workspace setup**: pick project, team and query source. Pin a project
  per organization and the app will auto-select it on next launch.
- **Visualize** (one screen, four tabs):
  - **Timeline / Gantt** (`vis-timeline`) — swimlanes by iteration,
    assignee, state or type. Drag any item to reschedule its
    `StartDate` / `TargetDate`.
  - **Hierarchy mind-map** (`@xyflow/react` + `dagre` TB layout) — expand /
    collapse subtrees with Alt-click.
  - **Dependency graph** (`@xyflow/react` + `dagre` LR layout) — toggle
    Hierarchy and Predecessor/Successor edges independently.
  - **Calendar** (`@fullcalendar/react`) — month / week views, drag to
    reschedule, color by type or state.
- **Sprint view**: independent of the workspace query. Pick an iteration and
  switch between two layouts:
  - **Matrix** — PBI-row × Task-column with the five standard child tasks
    (FE Dev, BE Dev, Testing, FE Code Review, BE Code Review) and an
    **Other** catch-all column. Per-PBI progress, owner avatar, sticky PBI
    column.
  - **Kanban** — three canonical lanes (**To Do / In Progress / Done**) that
    normalise across ADO process templates (Agile / Scrum / CMMI). Each
    card carries its parent PBI badge and the real ADO state, and a
    **Lite ⇄ Details** density toggle expands every card to show *all*
    sibling tasks under the same PBI.

  Both layouts share an "only mine", "hide fully done", and a multi-select
  **user filter** sourced from team members + actual sprint assignees +
  Unassigned.
- **Light editing**: change State, AssignedTo, Start/Target dates from a
  shared work-item drawer with optimistic updates and rollback on failure.
- **Search by id**: an Autocomplete in the top bar takes one or many
  work-item ids and remembers the last 10 per project (with titles).
- **Saved queries OR custom WIQL** as the data source. Tree
  (`WorkItemLinks`) WIQL is supported and used to populate the Hierarchy /
  Graph views in one round-trip.

## Architecture

```
+-----------------------------+      +------------------------------+
| Renderer (React SPA)        |      | Main (Electron)              |
| - MUI + styled-components   |      | - electron/main.ts           |
| - Redux Toolkit + RTK Query |      | - safeStorage PAT vault      |
| - @xyflow/react, vis-timeline,      | - ADO REST client (net.fetch,|
|   FullCalendar              |      |   retry, in-memory cache)    |
|                             | IPC  |                              |
|     window.ado.invoke <----------> ipcMain.handle('ado.*')        |
+-----------------------------+      +------------------------------+
                                                   |
                                                   v
                                  Azure DevOps REST API (v7.1)
```

## Getting started

```bash
npm install
npm run dev
```

The dev script starts both the Vite renderer and the Electron main process
with hot reload. On first launch you'll see the Connection screen.

### Personal Access Token

Create a PAT at
`https://dev.azure.com/<your-org>/_usersSettings/tokens` with these scopes:

- **Work Items**: Read & Write (Read-only is fine if you don't need editing)
- **Project and Team**: Read
- **Identity**: Read

Paste the PAT and the org URL (e.g. `https://dev.azure.com/contoso`). The PAT
is encrypted with your OS keychain (Windows DPAPI / macOS Keychain /
libsecret on Linux) and stored under your user-data directory; it never
reaches the renderer.

### Production builds

```bash
npm run build               # bundle main + preload + renderer to ./out
npm run package             # build + produce a Windows NSIS installer
npm run package:dir         # build + produce an unpacked dir (for smoke testing)
```

Outputs land in `release/<version>/`.

## Project layout

```
electron/        Main + preload (ADO client, token vault, IPC handlers)
shared/          Types + IPC contract used by both processes
src/             React renderer (pages, visualizations, store)
electron-builder.yml
electron.vite.config.ts
```

## Roadmap

- Entra ID OAuth (PKCE) auth flow as an alternative to PAT.
- Persist the active workspace (project / team / source / view) to disk.
- Configurable sprint task taxonomy (per team override of the FE/BE/QA/CR set).
- Burndown / cumulative-flow charts.
- Multi-org support.
