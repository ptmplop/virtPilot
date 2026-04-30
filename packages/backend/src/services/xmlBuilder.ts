import fs from 'fs';
import { execSync } from 'child_process';

export function kvmAvailable(): boolean {
  return fs.existsSync('/dev/kvm');
}

function findEmulator(): string {
  const candidates = [
    '/usr/bin/qemu-system-x86_64',
    '/usr/local/bin/qemu-system-x86_64',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  try {
    return execSync('which qemu-system-x86_64', { timeout: 3000 }).toString().trim();
  } catch {
    return '/usr/bin/qemu-system-x86_64';
  }
}

interface OvmfPaths {
  code: string;
  codeSecboot: string;
  vars: string;
}

function findOvmfPaths(): OvmfPaths | null {
  const candidates: OvmfPaths[] = [
    {
      code:        '/usr/share/OVMF/OVMF_CODE.fd',
      codeSecboot: '/usr/share/OVMF/OVMF_CODE.secboot.fd',
      vars:        '/usr/share/OVMF/OVMF_VARS.fd',
    },
    {
      code:        '/usr/share/OVMF/OVMF_CODE_4M.fd',
      codeSecboot: '/usr/share/OVMF/OVMF_CODE_4M.secboot.fd',
      vars:        '/usr/share/OVMF/OVMF_VARS_4M.fd',
    },
    {
      code:        '/usr/share/edk2-ovmf/x64/OVMF_CODE.fd',
      codeSecboot: '/usr/share/edk2-ovmf/x64/OVMF_CODE.secboot.fd',
      vars:        '/usr/share/edk2-ovmf/x64/OVMF_VARS.fd',
    },
  ];
  for (const c of candidates) {
    if (fs.existsSync(c.code) && fs.existsSync(c.vars)) return c;
  }
  return null;
}

const EMULATOR = findEmulator();
const OVMF = findOvmfPaths();

export type CpuMode = 'host-passthrough' | 'host-model' | 'maximum';
export type FirmwareMode = 'uefi' | 'bios';

export interface NicDefinition {
  bridge: string;
  mac: string;
  model?: string;
}

interface DomainXmlOptions {
  name: string;
  cpus: number;
  memoryMb: number;
  diskPath: string;
  cloudInitIsoPath?: string;
  installIsoPath?: string;
  nics: NicDefinition[];
  useKvm?: boolean;
  cpuMode?: CpuMode;
  firmware?: FirmwareMode;
  secureBoot?: boolean;
  nvramPath?: string;
  vtpm?: boolean;
}

export function buildDomainXml(opts: DomainXmlOptions): string {
  const memKb = opts.memoryMb * 1024;
  const kvm = opts.useKvm ?? kvmAvailable();
  const domainType = kvm ? 'kvm' : 'qemu';
  const cpuMode = opts.cpuMode ?? 'host-passthrough';
  const cpuXml = kvm
    ? cpuMode === 'host-model'
      ? `<cpu mode="host-model"/>`
      : cpuMode === 'maximum'
        ? `<cpu mode="maximum" check="none" migratable="on"/>`
        : `<cpu mode="host-passthrough" check="none" migratable="on"/>`
    : `<cpu mode="custom" match="exact"><model fallback="allow">qemu64</model></cpu>`;

  const useUefi = (opts.firmware ?? 'uefi') === 'uefi';
  const useSecureBoot = useUefi && (opts.secureBoot ?? false);

  let loaderXml = '';
  if (useUefi && OVMF) {
    const loaderPath = useSecureBoot && fs.existsSync(OVMF.codeSecboot)
      ? OVMF.codeSecboot
      : OVMF.code;
    const secureAttr = useSecureBoot ? ' secure="yes"' : '';
    loaderXml = `
    <loader readonly="yes"${secureAttr} type="pflash">${loaderPath}</loader>
    <nvram template="${OVMF.vars}">${opts.nvramPath ?? `/var/lib/libvirt/qemu/nvram/${opts.name}_VARS.fd`}</nvram>`;
  }

  const nicsXml = opts.nics
    .map((nic) =>
      `    <interface type="bridge">
      <mac address="${nic.mac}"/>
      <source bridge="${nic.bridge}"/>
      <model type="${nic.model ?? 'virtio'}"/>
    </interface>`
    )
    .join('\n');

  const isIsoInstall = !!opts.installIsoPath;
  const primaryCdromPath = isIsoInstall ? opts.installIsoPath! : opts.cloudInitIsoPath!;

  return `<domain type="${domainType}">
  <name>${opts.name}</name>
  <memory unit="KiB">${memKb}</memory>
  <currentMemory unit="KiB">${memKb}</currentMemory>
  <vcpu placement="static">${opts.cpus}</vcpu>
  <os>
    <type arch="x86_64" machine="q35">hvm</type>${loaderXml}
    ${isIsoInstall ? '<boot dev="cdrom"/>' : ''}
    <boot dev="hd"/>
  </os>
  <features>
    <acpi/>
    <apic/>
    ${useSecureBoot ? '<smm state="on"/>' : ''}
    ${kvm ? '<vmport state="off"/>' : ''}
  </features>
  ${cpuXml}
  <clock offset="utc">
    <timer name="rtc" tickpolicy="catchup"/>
    <timer name="pit" tickpolicy="delay"/>
    <timer name="hpet" present="no"/>
  </clock>
  <on_poweroff>destroy</on_poweroff>
  <on_reboot>restart</on_reboot>
  <on_crash>destroy</on_crash>
  <pm>
    <suspend-to-mem enabled="no"/>
    <suspend-to-disk enabled="no"/>
  </pm>
  <devices>
    <emulator>${EMULATOR}</emulator>
    <controller type="pci" index="0" model="pcie-root"/>
    <controller type="pci" index="1" model="pcie-root-port"/>
    <controller type="pci" index="2" model="pcie-root-port"/>
    <controller type="pci" index="3" model="pcie-root-port"/>
    <controller type="pci" index="4" model="pcie-root-port"/>
    <controller type="pci" index="5" model="pcie-root-port"/>
    <controller type="pci" index="6" model="pcie-root-port"/>
    <controller type="pci" index="7" model="pcie-root-port"/>
    <controller type="pci" index="8" model="pcie-root-port"/>
    <controller type="pci" index="9" model="pcie-root-port"/>
    <controller type="pci" index="10" model="pcie-root-port"/>
    <controller type="pci" index="11" model="pcie-root-port"/>
    <controller type="pci" index="12" model="pcie-root-port"/>
    <controller type="pci" index="13" model="pcie-root-port"/>
    <controller type="pci" index="14" model="pcie-root-port"/>
    <disk type="file" device="disk">
      <driver name="qemu" type="qcow2" discard="unmap" cache="none" io="native"/>
      <source file="${opts.diskPath}"/>
      <target dev="vda" bus="virtio"/>
    </disk>
    <disk type="file" device="cdrom">
      <driver name="qemu" type="raw"/>
      <source file="${primaryCdromPath}"/>
      <target dev="sda" bus="sata"/>
      <readonly/>
    </disk>
    <disk type="file" device="cdrom">
      <driver name="qemu" type="raw"/>
      <target dev="sdb" bus="sata"/>
      <readonly/>
    </disk>
${nicsXml}
    <serial type="pty">
      <target type="isa-serial" port="0">
        <model name="isa-serial"/>
      </target>
    </serial>
    <console type="pty">
      <target type="serial" port="0"/>
    </console>
    <graphics type="vnc" port="-1" autoport="yes" listen="127.0.0.1">
      <listen type="address" address="127.0.0.1"/>
    </graphics>
    <video>
      <model type="vga" vram="16384" heads="1" primary="yes"/>
    </video>
    <rng model="virtio">
      <backend model="random">/dev/urandom</backend>
    </rng>
    <memballoon model="virtio">
      <stats period="5"/>
    </memballoon>
    <channel type="unix">
      <target type="virtio" name="org.qemu.guest_agent.0"/>
    </channel>
    ${opts.vtpm ? `<tpm model="tpm-tis">
      <backend type="emulator" version="2.0"/>
    </tpm>` : ''}
  </devices>
</domain>`;
}

/** Generate a QEMU-compatible MAC address (52:54:00 OUI prefix) */
export function generateMac(): string {
  const bytes = Array.from({ length: 3 }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
  );
  return `52:54:00:${bytes.join(':')}`;
}
