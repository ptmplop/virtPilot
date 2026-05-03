import {
  siAdguard,
  siAlmalinux,
  siAlpinelinux,
  siArchlinux,
  siArtixlinux,
  siCentos,
  siDebian,
  siDeepin,
  siElementary,
  siEndeavouros,
  siFedora,
  siFreebsd,
  siGarudalinux,
  siGentoo,
  siHomeassistant,
  siKalilinux,
  siLinux,
  siLinuxmint,
  siManjaro,
  siMikrotik,
  siNetbsd,
  siNixos,
  siOpenbsd,
  siOpenmediavault,
  siOpensuse,
  siOpenwrt,
  siOpnsense,
  siPfsense,
  siPihole,
  siPopos,
  siProxmox,
  siQubesos,
  siRaspberrypi,
  siRedhat,
  siRockylinux,
  siSolus,
  siSuse,
  siTails,
  siTalos,
  siTruenas,
  siUbuntu,
  siVoidlinux,
  siZorin,
} from 'simple-icons';

export type OsLogoCategory = 'linux' | 'bsd' | 'security' | 'appliance' | 'other';

export interface OsLogo {
  slug: string;
  name: string;
  hex: string;  // brand colour without #
  path: string; // SVG path data
  category: OsLogoCategory;
}

// Windows logo: 4-square grid (not in simple-icons due to trademark)
const WINDOWS_LOGO: OsLogo = {
  slug: 'windows',
  name: 'Windows',
  hex: '0078D4',
  path: 'M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4h-13.051M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801',
  category: 'other',
};

interface IconSpec {
  icon: { slug: string; title: string; hex: string; path: string };
  category: OsLogoCategory;
}

const SPECS: IconSpec[] = [
  // Linux distributions
  { icon: siUbuntu, category: 'linux' },
  { icon: siDebian, category: 'linux' },
  { icon: siFedora, category: 'linux' },
  { icon: siCentos, category: 'linux' },
  { icon: siRedhat, category: 'linux' },
  { icon: siRockylinux, category: 'linux' },
  { icon: siAlmalinux, category: 'linux' },
  { icon: siOpensuse, category: 'linux' },
  { icon: siSuse, category: 'linux' },
  { icon: siArchlinux, category: 'linux' },
  { icon: siArtixlinux, category: 'linux' },
  { icon: siEndeavouros, category: 'linux' },
  { icon: siManjaro, category: 'linux' },
  { icon: siGarudalinux, category: 'linux' },
  { icon: siAlpinelinux, category: 'linux' },
  { icon: siVoidlinux, category: 'linux' },
  { icon: siGentoo, category: 'linux' },
  { icon: siNixos, category: 'linux' },
  { icon: siLinuxmint, category: 'linux' },
  { icon: siPopos, category: 'linux' },
  { icon: siElementary, category: 'linux' },
  { icon: siZorin, category: 'linux' },
  { icon: siDeepin, category: 'linux' },
  { icon: siSolus, category: 'linux' },
  { icon: siKalilinux, category: 'linux' },
  { icon: siRaspberrypi, category: 'linux' },
  { icon: siLinux, category: 'linux' }, // generic Tux fallback

  // BSD family
  { icon: siFreebsd, category: 'bsd' },
  { icon: siOpenbsd, category: 'bsd' },
  { icon: siNetbsd, category: 'bsd' },

  // Privacy / security
  { icon: siQubesos, category: 'security' },
  { icon: siTails, category: 'security' },

  // Turnkey appliances (network, storage, home, hypervisor, k8s)
  { icon: siPfsense, category: 'appliance' },
  { icon: siOpnsense, category: 'appliance' },
  { icon: siOpenwrt, category: 'appliance' },
  { icon: siMikrotik, category: 'appliance' },
  { icon: siTruenas, category: 'appliance' },
  { icon: siOpenmediavault, category: 'appliance' },
  { icon: siProxmox, category: 'appliance' },
  { icon: siHomeassistant, category: 'appliance' },
  { icon: siPihole, category: 'appliance' },
  { icon: siAdguard, category: 'appliance' },
  { icon: siTalos, category: 'appliance' },
];

export const OS_LOGOS: OsLogo[] = SPECS.map(({ icon, category }) => ({
  slug: icon.slug,
  name: icon.title,
  hex: icon.hex,
  path: icon.path,
  category,
})).concat(WINDOWS_LOGO);

export const CATEGORY_LABELS: Record<OsLogoCategory, string> = {
  linux: 'Linux',
  bsd: 'BSD',
  security: 'Privacy & Security',
  appliance: 'Appliances',
  other: 'Other',
};

// Order in which categories appear in the picker
export const CATEGORY_ORDER: OsLogoCategory[] = ['linux', 'bsd', 'security', 'appliance', 'other'];

export function findLogo(slug: string): OsLogo | undefined {
  return OS_LOGOS.find((l) => l.slug === slug);
}

// Relative luminance of a 6-digit hex (Rec. 601). Used to flag brand colours
// that are too dark to render against a tinted-with-itself background tile.
export function hexLuminance(hex: string): number {
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

export function isDarkHex(hex: string): boolean {
  return hexLuminance(hex) < 0.2;
}
