import {
  siAlmalinux,
  siAlpinelinux,
  siArchlinux,
  siCentos,
  siDebian,
  siFedora,
  siFreebsd,
  siGentoo,
  siKalilinux,
  siLinuxmint,
  siManjaro,
  siNixos,
  siOpensuse,
  siRaspberrypi,
  siRockylinux,
  siUbuntu,
} from 'simple-icons';

export interface OsLogo {
  slug: string;
  name: string;
  hex: string;  // brand colour without #
  path: string; // SVG path data
}

// Windows logo: 4-square grid (not in simple-icons due to trademark)
const WINDOWS_LOGO: OsLogo = {
  slug: 'windows',
  name: 'Windows',
  hex: '0078D4',
  path: 'M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4h-13.051M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801',
};

export const OS_LOGOS: OsLogo[] = [
  siUbuntu,
  siDebian,
  siFedora,
  siCentos,
  siArchlinux,
  siAlpinelinux,
  siOpensuse,
  siRockylinux,
  siAlmalinux,
  siFreebsd,
  siKalilinux,
  siNixos,
  siGentoo,
  siRaspberrypi,
  siManjaro,
  siLinuxmint,
].map((icon) => ({
  slug: icon.slug,
  name: icon.title,
  hex: icon.hex,
  path: icon.path,
})).concat(WINDOWS_LOGO);

export function findLogo(slug: string): OsLogo | undefined {
  return OS_LOGOS.find((l) => l.slug === slug);
}
