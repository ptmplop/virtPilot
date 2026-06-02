// Starter template set surfaced on the Templates page when no templates exist.
// Edit this list to change which images the "Download starter set" card pulls.
// `logo` slugs come from src/lib/osLogos.ts (e.g. ubuntu, debian, almalinux).
//
// All URLs were validated (HEAD 200) before being added. The bulk-download flow
// skips entries whose URL no longer responds with HTTP 200 at run time, so a
// dead link removed from a mirror won't abort the rest of the set.

import { OS_LOGOS } from '@/lib/osLogos';

export interface TemplateSetItem {
  url: string;
  filename: string;
  name: string;
  logo: string;
}

export interface TemplateSet {
  name: string;
  description: string;
  logo: string;
  templates: TemplateSetItem[];
}

export const TEMPLATE_SET: TemplateSet = {
  name: 'Essential cloud images',
  description: 'A starter pack of common amd64 Linux cloud images with cloud-init support.',
  logo: 'linux',
  templates: [
    {
      url: 'https://download.rockylinux.org/pub/rocky/9/images/x86_64/Rocky-9-GenericCloud.latest.x86_64.qcow2',
      filename: 'rocky-9.qcow2',
      name: 'Rocky Linux 9',
      logo: 'rockylinux',
    },
    {
      url: 'https://repo.almalinux.org/almalinux/9/cloud/x86_64/images/AlmaLinux-9-GenericCloud-latest.x86_64.qcow2',
      filename: 'almalinux-9.qcow2',
      name: 'AlmaLinux 9',
      logo: 'almalinux',
    },
    {
      url: 'https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img',
      filename: 'ubuntu-24.04.img',
      name: 'Ubuntu 24.04 LTS Noble',
      logo: 'ubuntu',
    },
    {
      url: 'https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2',
      filename: 'debian-13.qcow2',
      name: 'Debian 13 Trixie',
      logo: 'debian',
    },
    {
      url: 'https://download.opensuse.org/distribution/leap/15.6/appliances/openSUSE-Leap-15.6-Minimal-VM.x86_64-Cloud.qcow2',
      filename: 'opensuse-leap-15.6.qcow2',
      name: 'openSUSE Leap 15.6',
      logo: 'opensuse',
    },
    {
      // Pinned to a direct mirror because Fedora's `download.fedoraproject.org`
      // redirector geo-routes US clients to `ftp-chi.osuosl.org` →
      // `ftp2.osuosl.org`, which doesn't carry Fedora at all (their Fedora
      // mirror moved to `fedora.osuosl.org`). The redirector is sticky per
      // client IP, so retries don't help. gemmei.ftp.acc.umu.se is a stable
      // long-running academic mirror at Umeå University.
      url: 'https://gemmei.ftp.acc.umu.se/mirror/fedora/linux/releases/41/Cloud/x86_64/images/Fedora-Cloud-Base-Generic-41-1.4.x86_64.qcow2',
      filename: 'fedora-41.qcow2',
      name: 'Fedora 41 Cloud',
      logo: 'fedora',
    },
    {
      // UEFI variant — VirtPilot defines all VMs with `<os firmware='efi'>` (OVMF),
      // so the BIOS image (which uses SYSLINUX in MBR with no GPT/ESP) won't boot.
      url: 'https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/cloud/nocloud_alpine-3.21.7-x86_64-uefi-cloudinit-r0.qcow2',
      filename: 'alpine-3.21.qcow2',
      name: 'Alpine Linux 3.21',
      logo: 'alpinelinux',
    },
    {
      url: 'https://geo.mirror.pkgbuild.com/images/latest/Arch-Linux-x86_64-cloudimg.qcow2',
      filename: 'arch-latest.qcow2',
      name: 'Arch Linux (rolling)',
      logo: 'archlinux',
    },
  ],
};

// Best-effort OS-logo slug for a VM's source image filename. Tries the bundled
// template set first (exact match), then a substring match against known OS
// slugs, then a few codename aliases. Returns undefined when nothing matches,
// so callers fall back to a generic icon.
export function osSlugFromImage(filename?: string): string | undefined {
  if (!filename) return undefined;
  const f = filename.toLowerCase();

  for (const item of TEMPLATE_SET.templates) {
    if (item.filename.toLowerCase() === f) return item.logo;
  }

  // Longest slugs first so e.g. 'archlinux' wins over a hypothetical 'arch'.
  const slugs = OS_LOGOS.map((l) => l.slug).sort((a, b) => b.length - a.length);
  for (const slug of slugs) {
    if (f.includes(slug)) return slug;
  }

  // Distro codenames / short names that differ from their logo slug.
  if (/(noble|jammy|focal|ubuntu)/.test(f)) return 'ubuntu';
  if (/(trixie|bookworm|bullseye|debian)/.test(f)) return 'debian';
  if (/rocky/.test(f)) return 'rockylinux';
  if (/alma/.test(f)) return 'almalinux';
  return undefined;
}
