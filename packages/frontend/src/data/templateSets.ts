// Starter template set surfaced on the Templates page when no templates exist.
// Edit this list to change which images the "Download starter set" card pulls.
// `logo` slugs come from src/lib/osLogos.ts (e.g. ubuntu, debian, almalinux).
//
// All URLs were validated (HEAD 200) before being added. The bulk-download flow
// skips entries whose URL no longer responds with HTTP 200 at run time, so a
// dead link removed from a mirror won't abort the rest of the set.

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
      url: 'https://cloud.centos.org/centos/10-stream/x86_64/images/CentOS-Stream-GenericCloud-10-latest.x86_64.qcow2',
      filename: 'centos-stream-10.qcow2',
      name: 'CentOS Stream 10',
      logo: 'centos',
    },
    {
      url: 'https://download.opensuse.org/distribution/leap/15.6/appliances/openSUSE-Leap-15.6-Minimal-VM.x86_64-Cloud.qcow2',
      filename: 'opensuse-leap-15.6.qcow2',
      name: 'openSUSE Leap 15.6',
      logo: 'opensuse',
    },
    {
      url: 'https://download.fedoraproject.org/pub/fedora/linux/releases/41/Cloud/x86_64/images/Fedora-Cloud-Base-Generic-41-1.4.x86_64.qcow2',
      filename: 'fedora-41.qcow2',
      name: 'Fedora 41 Cloud',
      logo: 'fedora',
    },
    {
      url: 'https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/cloud/nocloud_alpine-3.21.0-x86_64-bios-cloudinit-r0.qcow2',
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
