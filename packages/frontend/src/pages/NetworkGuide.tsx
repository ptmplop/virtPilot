import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Callout as SharedCallout } from '@/components/ui/Callout';

function Code({ children }: { children: string }) {
  return (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground [box-decoration-break:clone]">
      {children}
    </code>
  );
}

function CodeBlock({ code }: { code: string }) {
  return (
    <pre className="mt-2 overflow-x-auto rounded-lg bg-muted px-4 py-3 font-mono text-xs leading-relaxed text-foreground whitespace-pre">
      {code}
    </pre>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-px w-4 shrink-0 text-right text-[13px] font-medium tabular-nums text-muted-foreground">
        {n}.
      </span>
      <div className="min-w-0 flex-1 text-[13.5px] leading-relaxed text-foreground">{children}</div>
    </li>
  );
}

function Steps({ children }: { children: React.ReactNode }) {
  return <ol className="mt-3 space-y-4">{children}</ol>;
}

// Difficulty is a word in the option's own colour — not a tinted chip.
// How hard an option is, said in words: green, amber and blue here read as statuses.
function SectionBadge({ label }: { label: string }) {
  return <span className="text-[12.5px] font-medium text-muted-foreground">{label}</span>;
}

// The app's callout recipe — the guide used to have its own, and the only blue tint.
function Callout({ variant, children }: { variant: 'warning' | 'tip'; children: React.ReactNode }) {
  return (
    <SharedCallout tone={variant === 'warning' ? 'warn' : 'info'} className="mt-4">
      {children}
    </SharedCallout>
  );
}

function Divider() {
  return <div className="border-b border-border" />;
}

export function NetworkGuide({ open, onClose }: { open: boolean; onClose: () => void }) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  // Holds the keyboard while open, as a dialog does, and hands focus back afterwards.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, [open, onClose]);

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-40 bg-[#1B2433]/40 animate-fade-in dark:bg-black/70"
          onClick={onClose}
        />
      )}
      {/* Invisible while closed: parked off-screen it would still cast its shadow over the
          page and keep its links in the tab order. Flips only after the slide. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn(
          'fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col border-l border-border bg-card shadow-pop transition-[transform,visibility] duration-200',
          open ? 'translate-x-0' : 'invisible translate-x-full'
        )}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-border px-6 py-4">
          <div>
            <h2 id={titleId} className="text-[16px] font-semibold tracking-[-0.01em] text-foreground">Network setup guide</h2>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              Step-by-step instructions for every network configuration.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close guide"
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto">
          <div className="space-y-8 px-6 py-6">

            {/* Decision helper */}
            <div className="rounded-xl border border-border bg-muted/40 p-4 text-sm">
              <p className="mb-3 font-semibold text-foreground">Which option do I need?</p>
              <div className="space-y-2 text-muted-foreground">
                <p>
                  <span className="font-medium text-foreground">VMs just need internet access</span>
                  {' '}- use <span className="font-medium text-foreground">Option 1: NAT</span>. Easiest, nothing to configure on the host OS.
                </p>
                <p>
                  <span className="font-medium text-foreground">VMs need IPs on your physical/public network</span>
                  {' '}and you have a <span className="font-medium text-foreground">spare NIC with no IP on it</span>
                  {' '}- use <span className="font-medium text-foreground">Option 2: Bridge with a dedicated NIC</span>.
                </p>
                <p>
                  <span className="font-medium text-foreground">VMs need IPs on your physical/public network</span>
                  {' '}and <span className="font-medium text-foreground">your only NIC is your SSH/management interface</span>
                  {' '}(most cloud servers) - use <span className="font-medium text-foreground">Option 3</span> to configure a bridge at the OS level first.
                </p>
                <p>
                  <span className="font-medium text-foreground">You already have a Linux bridge set up at the OS level</span>
                  {' '}- use <span className="font-medium text-foreground">Option 4: Existing OS bridge</span> to attach VirtPilot to it.
                </p>
                <p>
                  <span className="font-medium text-foreground">VMs need a private network between them</span>
                  {' '}- use <span className="font-medium text-foreground">Option 5: VXLAN</span>, on this host or across several.
                </p>
              </div>
            </div>

            <Divider />

            {/* Option 1 — NAT */}
            <section className="space-y-3">
              <SectionBadge label="Easiest" />
              <h3 className="text-sm font-semibold text-foreground">Option 1: NAT network</h3>
              <p className="text-sm text-muted-foreground">
                VirtPilot creates an isolated network using libvirt's built-in NAT. VMs receive private IPs via DHCP
                and can reach the internet through the host. External systems cannot initiate connections to VMs
                (unless you add port forwards). No changes to the host OS are required.
              </p>
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">Best for:</span> development environments,
                internal services, anything that doesn't need a public IP.
              </p>
              <Steps>
                <Step n={1}>Click <strong>New network</strong>.</Step>
                <Step n={2}>Set <strong>Type</strong> to <strong>NAT</strong>.</Step>
                <Step n={3}>
                  Leave the CIDR as suggested (e.g. <Code>10.0.1.0/24</Code>), or enter any
                  private range that doesn't conflict with your existing networks.
                </Step>
                <Step n={4}>
                  Click <strong>Create network</strong>. VirtPilot creates a libvirt network, bridge, and DHCP
                  server automatically. VMs attached to this network will receive addresses like{' '}
                  <Code>10.0.1.2</Code> when they boot.
                </Step>
              </Steps>
            </section>

            <Divider />

            {/* Option 2 — Bridge with dedicated NIC */}
            <section className="space-y-3">
              <SectionBadge label="Medium" />
              <h3 className="text-sm font-semibold text-foreground">Option 2: Bridge with a dedicated NIC</h3>
              <p className="text-sm text-muted-foreground">
                VirtPilot creates a Linux bridge and enslaves a physical NIC to it. VMs plugged into this bridge
                appear on your upstream network as if they were physical machines - they receive IPs from your
                upstream DHCP server, or you assign static IPs from a pool you control.
              </p>
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">Requires:</span> a NIC that has{' '}
                <strong>no active IP address</strong> - dedicated entirely to VMs. Your SSH/management
                traffic must run over a separate interface.
              </p>
              <p className="text-sm text-muted-foreground">
                The bridge comes back by itself after a reboot, and VirtPilot puts the NIC back on it and
                brings it up, with nothing to configure on the host. It won't take a NIC that has since
                picked up an IP address or the host's default route, because that could cut the host off.
                The Networks page says so instead, and the NIC goes back on once it is free again. Leave
                the NIC out of netplan: if netplan names it, VirtPilot gives it two and a half minutes
                after each boot in case it is getting an address, and the bridge has no way out until then.
              </p>

              <Callout variant="tip">
                In the NIC picker, any interface that currently has an IP address is greyed out and
                cannot be selected. If all your NICs are greyed out, use Option 3 instead.
              </Callout>

              <Steps>
                <Step n={1}>Click <strong>New network</strong>.</Step>
                <Step n={2}>Set <strong>Type</strong> to <strong>Bridge</strong>.</Step>
                <Step n={3}>
                  Set <strong>IP mode</strong>:
                  <ul className="mt-2 space-y-1 text-sm text-muted-foreground list-disc list-inside">
                    <li><strong>DHCP</strong> - your upstream router assigns IPs to VMs. No further IP configuration needed in VirtPilot.</li>
                    <li><strong>Static</strong> - you own a block of IPs and VirtPilot assigns them from a pool via cloud-init. Enter the CIDR and gateway of that block.</li>
                  </ul>
                </Step>
                <Step n={4}>
                  Under <strong>Physical NIC</strong>, select the dedicated NIC (the one with no active IP).
                </Step>
                <Step n={5}>Click <strong>Create network</strong>.</Step>
              </Steps>
            </section>

            <Divider />

            {/* Option 3 — Single NIC cloud server */}
            <section className="space-y-3">
              <SectionBadge label="Advanced" />
              <h3 className="text-sm font-semibold text-foreground">
                Option 3: Bridge on a single-NIC server (most cloud servers)
              </h3>
              <p className="text-sm text-muted-foreground">
                Many servers - particularly cloud and dedicated servers - have a single NIC that carries
                both your SSH connection and your public IP. VirtPilot cannot safely enslave this NIC at
                runtime - doing so would instantly drop your SSH session. The solution is to convert the
                NIC into a bridge at the <strong>OS networking layer</strong> before VirtPilot ever touches it.
              </p>
              <p className="text-sm text-muted-foreground">
                Once the OS bridge is set up, your IP stays on the bridge (<Code>br0</Code>) rather than
                the raw NIC (<Code>eth0</Code>). The NIC becomes a bridge port. Your SSH session is unaffected
                and VirtPilot can attach VMs to the bridge using <strong>Option 4</strong>.
              </p>

              <Callout variant="warning">
                <strong>Before you start:</strong> if possible, do this over your server's out-of-band
                console (most providers offer one) rather than SSH. A configuration error will require a
                reboot to fix. On Ubuntu with Netplan, use <Code>netplan try</Code> (which auto-rolls
                back after 2 minutes if you don't confirm) rather than <Code>netplan apply</Code> for
                extra safety.
              </Callout>

              {/* Ubuntu / Netplan */}
              <p className="mt-2 text-sm font-semibold text-foreground">Ubuntu (Netplan)</p>
              <p className="text-sm text-muted-foreground">
                Netplan is the default network configuration tool on Ubuntu 18.04 and later. Config files
                live in <Code>/etc/netplan/</Code>.
              </p>
              <Steps>
                <Step n={1}>
                  Note your current interface name, IP, and gateway.
                  <CodeBlock code="ip addr show
ip route show" />
                </Step>
                <Step n={2}>
                  Find your current netplan file.
                  <CodeBlock code="ls /etc/netplan/" />
                </Step>
                <Step n={3}>
                  Replace the file contents with a bridge configuration. Substitute{' '}
                  <Code>eth0</Code> with your interface name.
                  <p className="mt-2 text-[12px] font-medium text-muted-foreground">If your server uses DHCP:</p>
                  <CodeBlock code={`# /etc/netplan/01-bridge.yaml
network:
  version: 2
  ethernets:
    eth0:
      dhcp4: no
  bridges:
    br0:
      interfaces: [eth0]
      dhcp4: yes
      parameters:
        stp: false
        forward-delay: 0`} />
                  <p className="mt-3 text-[12px] font-medium text-muted-foreground">If your server uses a static IP:</p>
                  <CodeBlock code={`# /etc/netplan/01-bridge.yaml
network:
  version: 2
  ethernets:
    eth0:
      dhcp4: no
  bridges:
    br0:
      interfaces: [eth0]
      dhcp4: no
      addresses: [YOUR.IP.HERE/PREFIX]
      routes:
        - to: 0.0.0.0/0
          via: YOUR.GATEWAY.HERE
          on-link: true    # needed if gateway is outside your subnet (e.g. /32 or /128)
      nameservers:
        addresses: [8.8.8.8, 8.8.4.4]
      parameters:
        stp: false
        forward-delay: 0`} />
                </Step>
                <Step n={4}>
                  Test the configuration - it will auto-revert after 120 seconds unless you confirm.
                  <CodeBlock code="netplan try" />
                  If your SSH session stays connected, confirm by pressing <Code>Enter</Code>.
                  If the session drops, wait 2 minutes - it will roll back automatically.
                </Step>
                <Step n={5}>
                  Once confirmed, verify the bridge has your IP.
                  <CodeBlock code="ip addr show br0
ip route show" />
                </Step>
                <Step n={6}>
                  In VirtPilot: go to <strong>New network → Existing OS bridge</strong> and enter <Code>br0</Code> as the bridge name (see Option 4).
                </Step>
              </Steps>

              {/* Debian / interfaces */}
              <p className="mt-6 text-sm font-semibold text-foreground">Debian / Ubuntu (traditional /etc/network/interfaces)</p>
              <p className="text-sm text-muted-foreground">
                Used on Debian and older Ubuntu installs. Requires the <Code>bridge-utils</Code> package.
              </p>
              <Steps>
                <Step n={1}>
                  Install bridge utilities.
                  <CodeBlock code="apt install bridge-utils" />
                </Step>
                <Step n={2}>
                  Edit <Code>/etc/network/interfaces</Code>. Replace <Code>eth0</Code> with your
                  interface name, and fill in your actual IP, netmask, and gateway.
                  <CodeBlock code={`auto lo
iface lo inet loopback

# Raw NIC - no IP, managed by bridge
auto eth0
iface eth0 inet manual

# Bridge - gets the IP that eth0 used to have
auto br0
iface br0 inet static
  address   YOUR.IP.HERE
  netmask   YOUR.NETMASK.HERE
  gateway   YOUR.GATEWAY.HERE
  bridge_ports     eth0
  bridge_stp       off
  bridge_fd        0
  bridge_waitport  0`} />
                  <p className="mt-2 text-xs text-muted-foreground">
                    Some providers assign a <Code>/32</Code> (single-host) IP with a gateway on a different
                    subnet. In that case the netmask is <Code>255.255.255.255</Code> and you need an extra
                    host route so the gateway is reachable:{' '}
                    <Code>post-up ip route add YOUR.GATEWAY.HERE dev br0</Code>. Check your provider's
                    network documentation for the correct gateway address.
                  </p>
                </Step>
                <Step n={3}>
                  Reboot. This is the safest method - the bridge will come up correctly on boot.
                  <CodeBlock code="reboot" />
                </Step>
                <Step n={4}>
                  After reboot, verify.
                  <CodeBlock code="ip addr show br0
brctl show br0" />
                </Step>
                <Step n={5}>
                  In VirtPilot: go to <strong>New network → Existing OS bridge</strong> and enter <Code>br0</Code> as the bridge name (see Option 4).
                </Step>
              </Steps>
            </section>

            <Divider />

            {/* Option 4 — Existing OS bridge */}
            <section className="space-y-3">
              <SectionBadge label="Any server" />
              <h3 className="text-sm font-semibold text-foreground">Option 4: Existing OS bridge</h3>
              <p className="text-sm text-muted-foreground">
                If you already have a Linux bridge configured at the OS level (via Option 3 above, or any
                other method), use this to attach VirtPilot to it. VirtPilot records the bridge name and attaches
                VMs to it, but will <strong>never modify or delete it</strong>.
              </p>
              <Steps>
                <Step n={1}>
                  Confirm the bridge exists.
                  <CodeBlock code="ip link show type bridge" />
                </Step>
                <Step n={2}>Click <strong>New network</strong>.</Step>
                <Step n={3}>Set <strong>Type</strong> to <strong>Existing OS bridge</strong>.</Step>
                <Step n={4}>
                  Set <strong>IP mode</strong>:
                  <ul className="mt-2 space-y-1 text-sm text-muted-foreground list-disc list-inside">
                    <li><strong>DHCP</strong> - your upstream network assigns IPs to VMs.</li>
                    <li><strong>Static</strong> - VirtPilot assigns IPs from a pool you define. Enter the CIDR and gateway of the IP range you want VirtPilot to manage.</li>
                  </ul>
                </Step>
                <Step n={5}>
                  Enter the <strong>Bridge name</strong> exactly as it appears on the host (e.g. <Code>br0</Code>).
                  VirtPilot will verify the bridge exists before saving.
                </Step>
                <Step n={6}>Click <strong>Create network</strong>.</Step>
              </Steps>
            </section>

            <Divider />

            {/* Option 5 — VXLAN */}
            <section className="space-y-3">
              <SectionBadge label="Easy" />
              <h3 className="text-sm font-semibold text-foreground">Option 5: VXLAN</h3>
              <p className="text-sm text-muted-foreground">
                A private network that connects VMs to each other. VMs on it reach each other and nothing
                else, and it carries no internet traffic, so a VM that needs to get out keeps a NAT or bridge
                NIC as well. Each VXLAN has an ID from 1 to 16777215 that no other VXLAN on the host can have.
                Nothing on the host OS has to change, and it comes back by itself after a reboot.
              </p>
              <Steps>
                <Step n={1}>Click <strong>New VXLAN</strong> on the VXLANs panel.</Step>
                <Step n={2}>
                  Under <strong>VXLAN ID</strong>, keep <strong>Next available</strong>, or choose an ID of your own.
                  VirtPilot refuses one that already exists, whether it made it or not.
                </Step>
                <Step n={3}>
                  Set <strong>Addresses</strong>:
                  <ul className="mt-2 list-disc space-y-1 pl-4 text-[13.5px] text-muted-foreground [&_strong]:text-foreground">
                    <li><strong>DHCP</strong> - this host hands out addresses from the CIDR and takes one for itself. The usual choice.</li>
                    <li><strong>Static</strong> - you pick each VM's address when you add it, and cloud-init sets it. This host has no address on the network, so the dashboard's SSH console can't reach a VM through it.</li>
                    <li><strong>None</strong> - VirtPilot stays out of it. Set addresses inside the VMs, or run a DHCP server on the network.</li>
                  </ul>
                </Step>
                <Step n={4}>Click <strong>Create network</strong>. MTU, UDP port and remote hosts are under <strong>Show optional settings</strong>.</Step>
                <Step n={5}>
                  Tick it in the VM wizard's <strong>Network</strong> step as well as your NAT network, leaving the NAT
                  network as primary. Cloud-init then sets it up by itself. To connect a VM you already have, use{' '}
                  <strong>Connect a VM</strong> on the VXLAN's row, or <strong>Add NIC</strong> on the VM's Network tab,
                  and configure the new NIC inside the VM.
                </Step>
              </Steps>

              <h4 className="pt-3 text-[13.5px] font-semibold text-foreground">Across several hosts</h4>
              <p className="text-sm text-muted-foreground">
                Remote hosts extend a VXLAN to VMs on other machines, over any network that can carry UDP between them.
              </p>
              <Steps>
                <Step n={1}>
                  On every host, make a VXLAN with the <strong>same ID, UDP port and MTU</strong>. Let only one of
                  them hand out addresses, by choosing <strong>None</strong> on the others: two DHCP servers on one
                  network hand out clashing addresses.
                </Step>
                <Step n={2}>
                  Open <strong>Remote hosts</strong> on its row and list the other hosts by address. Do this on each host:
                  every host lists all the others.
                </Step>
                <Step n={3}>
                  A remote host shows how many machines have been seen behind it, once frames arrive from it.
                  If it stays at <strong>Nothing received yet</strong> with VMs running on both sides, check the
                  addresses first, then any firewall between the hosts: UDP 4789 has to pass in both directions.
                </Step>
              </Steps>

              <Callout variant="warning">
                <strong>VXLAN does not encrypt or authenticate anything.</strong> Between hosts, use a private
                link or a VPN. On this host, VirtPilot adds firewall rules so only the hosts you list can reach
                each VXLAN, and with no remote hosts its tunnel stays down and nothing listens at all.
              </Callout>
              <h4 className="pt-3 text-[13.5px] font-semibold text-foreground">VLANs inside a VXLAN</h4>
              <p className="text-sm text-muted-foreground">
                A VM can tag its own traffic on a VXLAN, with nothing to set up on the host: tags pass through the
                bridge and the tunnel untouched, between VMs on this host and across remote hosts. Both 802.1Q and
                nested tagging (QinQ, with an 802.1ad or 802.1Q outer tag) work at the full MTU.
              </p>
              <Steps>
                <Step n={1}>
                  On each VM, add a VLAN interface on its VXLAN NIC. Here <Code>eth1</Code> is that NIC:
                  <CodeBlock code={`# One tag
ip link add link eth1 name eth1.10 type vlan id 10
ip addr add 192.168.10.1/24 dev eth1.10
ip link set eth1.10 up

# Two tags (QinQ)
ip link add link eth1 name eth1.100 type vlan proto 802.1ad id 100
ip link add link eth1.100 name eth1.100.200 type vlan id 200
ip addr add 192.168.200.1/24 dev eth1.100.200
ip link set eth1.100 up
ip link set eth1.100.200 up`} />
                </Step>
                <Step n={2}>
                  To keep a VLAN across reboots on Ubuntu or Debian, add it to netplan:
                  <CodeBlock code={`network:
  version: 2
  vlans:
    eth1.10:
      id: 10
      link: eth1
      addresses: [192.168.10.1/24]`} />
                </Step>
              </Steps>
              <p className="text-sm text-muted-foreground">
                VLAN IDs inside a VXLAN belong to the VMs: VirtPilot doesn't assign or enforce them, so any VM on the
                VXLAN can use any tag. This host's DHCP server answers untagged traffic only, so give a VLAN its
                addresses inside the VMs, or run a DHCP server on it.
              </p>

              <Callout variant="tip">
                The MTU is 1442 by default: a VXLAN's own headers plus two VLAN tags, inside a standard 1500-byte
                link, so nothing is ever fragmented. VMs using virtio NICs pick it up by themselves, and their VLAN
                interfaces inherit it. A VM with another NIC model takes it from DHCP or cloud-init; set up by hand, it
                needs it set inside the VM, or large packets on this network are lost.
              </Callout>
              <Callout variant="tip">
                A VM's firewall tab doesn't filter traffic inside a VXLAN: it passes through the bridge directly.
                To restrict what VMs on one VXLAN can do to each other, use a firewall inside the VMs.
              </Callout>
            </section>

            <Divider />

            {/* IP mode explainer */}
            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-foreground">IP mode on a bridge: DHCP or static</h3>
              <p className="text-sm text-muted-foreground">
                This setting controls how VMs get their IP addresses when connected to a bridge network.
              </p>
              <div className="space-y-3 text-sm">
                <div className="rounded-lg border border-border p-3">
                  <p className="font-medium text-foreground">DHCP</p>
                  <p className="mt-1 text-muted-foreground">
                    Your upstream router or DHCP server assigns an IP to each VM when it boots. You don't
                    manage IPs in VirtPilot - the upstream handles it. Best when VMs are on a LAN with an
                    existing DHCP server, or when your hosting provider handles DHCP for your network.
                  </p>
                </div>
                <div className="rounded-lg border border-border p-3">
                  <p className="font-medium text-foreground">Static</p>
                  <p className="mt-1 text-muted-foreground">
                    You define a CIDR block (e.g. <Code>203.0.113.0/29</Code>) and a gateway. VirtPilot
                    tracks which IP is assigned to which VM and injects the network configuration via
                    cloud-init when the VM is created. Best for public IP blocks where there is no DHCP
                    server - for example, additional IPs from your hosting provider that you've routed to
                    this server.
                  </p>
                </div>
              </div>
            </section>

          </div>
        </div>
      </div>
    </>
  );
}
