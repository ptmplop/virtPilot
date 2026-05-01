# VirtPilot — KVM Manager

Web-based KVM/QEMU management UI. Monorepo with Express backend + Vite/React frontend.

## Project Structure

```
packages/backend/   Express + TypeScript — wraps virsh/libvirt
packages/frontend/  Vite + React 18 + TypeScript + Tailwind CSS v3
```

## Stack

- **Backend**: Express, TypeScript, node-pty (console WebSocket), multer (file uploads), ws
- **Frontend**: Vite, React 18, TypeScript, Tailwind CSS v3, React Query, Zustand, Axios, xterm.js
- **VM management**: libvirt via `virsh` CLI (requires `libvirt-daemon-system` on host)
- **Cloud-init**: generates `meta-data`/`user-data`, builds `seed.iso` with `genisoimage`

## Starting

### Backend
```bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 20
cd packages/backend
cp .env.example .env   # edit storage paths and bridge
npx tsx src/index.ts
```
Backend listens on port 3001.

### Frontend
```bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 20
cd packages/frontend
npx vite
```
Frontend at http://localhost:5174. Proxies `/api` and `/ws` to backend.

## Install (from monorepo root)
```bash
npm install
```

## Host Requirements (Debian/Ubuntu)
```bash
apt install libvirt-daemon-system libvirt-clients qemu-kvm qemu-utils genisoimage
usermod -aG libvirt $USER
```

## Key Design Decisions

- No database — state is derived live from libvirt via `virsh` commands
- Console: WebSocket at `/ws/console?vm=<name>` → node-pty → `virsh console`
- Storage layout: `$STORAGE_ROOT/{templates,isos,vms,cloud-init}`
- VM creation: creates qcow2 overlay from template, generates cloud-init ISO, defines libvirt domain XML, calls `virsh define`
- Networking: bridged only; bridge must pre-exist on host
- NAT bridge names: `vp0`, `vp1`, ... (libvirt network names: `virtpilot-{uuid8}`)
- Firewall iptables chains: `VP-IN-{vmName}`, `VP-OUT-{vmName}`

## Before every commit — mandatory version bump

Every commit must update all four of these. No exceptions.

1. `packages/frontend/package.json` — bump `"version"`
2. `packages/backend/package.json` — bump `"version"` to match
3. `packages/frontend/src/components/layout/Layout.tsx` — bump the hardcoded version string in the sidebar footer (e.g. `v1.7.0`)
4. `CHANGELOG.md` (repo root, Keep a Changelog format) **and** `packages/frontend/src/data/releaseNotes.ts` (TypeScript array that drives the dashboard About section) — add a new entry to both

Version increment rules:
- **Patch** (x.x.N) — fixes, tweaks, cosmetic changes
- **Minor** (x.N.0) — meaningful new features or notable UX additions
- **Major** (N.0.0) — breaking changes or major rewrites

## Conventions

- British English in UI copy
- camelCase TypeScript throughout
- Tailwind CSS v3 with `darkMode: 'class'` — same CSS variable palette as hostedai-launchpad
- Dark mode stored in `localStorage` key `virtpilotTheme`
- **When a feature requires a new host package**, always update **both** `install.sh` (apt-get install block) and `update.sh` (apt packages section) in the same commit.
