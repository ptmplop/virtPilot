import { X } from 'lucide-react';
import { cn } from '@/lib/cn';

function Code({ children }: { children: string }) {
  return (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
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
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 font-bold text-[10px] text-primary">
        {n}
      </span>
      <div className="flex-1 text-sm leading-relaxed text-foreground">{children}</div>
    </li>
  );
}

function Steps({ children }: { children: React.ReactNode }) {
  return <ol className="mt-3 space-y-4">{children}</ol>;
}

function SectionBadge({ label, color }: { label: string; color: string }) {
  return (
    <span className={cn('rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest', color)}>
      {label}
    </span>
  );
}

function Callout({ variant, children }: { variant: 'warning' | 'tip'; children: React.ReactNode }) {
  return (
    <div className={cn(
      'mt-4 rounded-lg border px-4 py-3 text-sm',
      variant === 'warning'
        ? 'border-amber-500/20 bg-amber-500/5 text-amber-700 dark:text-amber-300'
        : 'border-blue-500/20 bg-blue-500/5 text-blue-700 dark:text-blue-300'
    )}>
      {children}
    </div>
  );
}

function Divider() {
  return <div className="border-b border-border" />;
}

export function NetworkGuide({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
          onClick={onClose}
        />
      )}
      <div
        className={cn(
          'fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col bg-card border-l border-border shadow-2xl transition-transform duration-200',
          open ? 'translate-x-0' : 'translate-x-full'
        )}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-border px-6 py-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Network Setup Guide</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Step-by-step instructions for every network configuration
            </p>
          </div>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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
                  {' '}— use <Code>Option 1: NAT</Code>. Easiest, nothing to configure on the host OS.
                </p>
                <p>
                  <span className="font-medium text-foreground">VMs need IPs on your physical/public network</span>
                  {' '}and you have a <span className="font-medium text-foreground">spare NIC with no IP on it</span>
                  {' '}— use <Code>Option 2: Bridge with a dedicated NIC</Code>.
                </p>
                <p>
                  <span className="font-medium text-foreground">VMs need IPs on your physical/public network</span>
                  {' '}and <span className="font-medium text-foreground">your only NIC is your SSH/management interface</span>
                  {' '}(most cloud servers) — use <Code>Option 3</Code> to configure a bridge at the OS level first.
                </p>
                <p>
                  <span className="font-medium text-foreground">You already have a Linux bridge set up at the OS level</span>
                  {' '}— use <Code>Option 4: Existing OS bridge</Code> to attach VirtPilot to it.
                </p>
              </div>
            </div>

            <Divider />

            {/* Option 1 — NAT */}
            <section className="space-y-3">
              <SectionBadge label="Easiest" color="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" />
              <h3 className="text-sm font-semibold text-foreground">Option 1 — NAT Network</h3>
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
                <Step n={1}>Click <strong>New Network</strong>.</Step>
                <Step n={2}>Set <strong>Type</strong> to <Code>NAT</Code>.</Step>
                <Step n={3}>
                  Leave the CIDR as suggested (e.g. <Code>10.0.1.0/24</Code>), or enter any
                  private range that doesn't conflict with your existing networks.
                </Step>
                <Step n={4}>
                  Click <strong>Create</strong>. VirtPilot creates a libvirt network, bridge, and DHCP
                  server automatically. VMs attached to this network will receive addresses like{' '}
                  <Code>10.0.1.2</Code> when they boot.
                </Step>
              </Steps>
            </section>

            <Divider />

            {/* Option 2 — Bridge with dedicated NIC */}
            <section className="space-y-3">
              <SectionBadge label="Medium" color="bg-amber-500/10 text-amber-600 dark:text-amber-400" />
              <h3 className="text-sm font-semibold text-foreground">Option 2 — Bridge with a dedicated NIC</h3>
              <p className="text-sm text-muted-foreground">
                VirtPilot creates a Linux bridge and enslaves a physical NIC to it. VMs plugged into this bridge
                appear on your upstream network as if they were physical machines — they receive IPs from your
                upstream DHCP server, or you assign static IPs from a pool you control.
              </p>
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">Requires:</span> a NIC that has{' '}
                <strong>no active IP address</strong> — dedicated entirely to VMs. Your SSH/management
                traffic must run over a separate interface.
              </p>

              <Callout variant="tip">
                In the NIC picker, any interface that currently has an IP address is greyed out and
                cannot be selected. If all your NICs are greyed out, use Option 3 instead.
              </Callout>

              <Steps>
                <Step n={1}>Click <strong>New Network</strong>.</Step>
                <Step n={2}>Set <strong>Type</strong> to <Code>Bridge</Code>.</Step>
                <Step n={3}>
                  Set <strong>IP Mode</strong>:
                  <ul className="mt-2 space-y-1 text-sm text-muted-foreground list-disc list-inside">
                    <li><Code>DHCP</Code> — your upstream router assigns IPs to VMs. No further IP configuration needed in VirtPilot.</li>
                    <li><Code>Static</Code> — you own a block of IPs and VirtPilot assigns them from a pool via cloud-init. Enter the CIDR and gateway of that block.</li>
                  </ul>
                </Step>
                <Step n={4}>
                  Under <strong>Physical NIC</strong>, select the dedicated NIC (the one with no active IP).
                </Step>
                <Step n={5}>Click <strong>Create</strong>.</Step>
              </Steps>
            </section>

            <Divider />

            {/* Option 3 — Single NIC cloud server */}
            <section className="space-y-3">
              <SectionBadge label="Advanced" color="bg-blue-500/10 text-blue-600 dark:text-blue-400" />
              <h3 className="text-sm font-semibold text-foreground">
                Option 3 — Bridge on a single-NIC server (most cloud servers)
              </h3>
              <p className="text-sm text-muted-foreground">
                Many servers — particularly cloud and dedicated servers — have a single NIC that carries
                both your SSH connection and your public IP. VirtPilot cannot safely enslave this NIC at
                runtime — doing so would instantly drop your SSH session. The solution is to convert the
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
                  <p className="mt-2 text-xs font-medium text-muted-foreground uppercase tracking-widest">If your server uses DHCP:</p>
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
                  <p className="mt-3 text-xs font-medium text-muted-foreground uppercase tracking-widest">If your server uses a static IP:</p>
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
                  Test the configuration — it will auto-revert after 120 seconds unless you confirm.
                  <CodeBlock code="netplan try" />
                  If your SSH session stays connected, confirm by pressing <Code>Enter</Code>.
                  If the session drops, wait 2 minutes — it will roll back automatically.
                </Step>
                <Step n={5}>
                  Once confirmed, verify the bridge has your IP.
                  <CodeBlock code="ip addr show br0
ip route show" />
                </Step>
                <Step n={6}>
                  In VirtPilot: go to <strong>New Network → Existing OS bridge</strong> and enter <Code>br0</Code> as the bridge name (see Option 4).
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

# Raw NIC — no IP, managed by bridge
auto eth0
iface eth0 inet manual

# Bridge — gets the IP that eth0 used to have
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
                  Reboot. This is the safest method — the bridge will come up correctly on boot.
                  <CodeBlock code="reboot" />
                </Step>
                <Step n={4}>
                  After reboot, verify.
                  <CodeBlock code="ip addr show br0
brctl show br0" />
                </Step>
                <Step n={5}>
                  In VirtPilot: go to <strong>New Network → Existing OS bridge</strong> and enter <Code>br0</Code> as the bridge name (see Option 4).
                </Step>
              </Steps>
            </section>

            <Divider />

            {/* Option 4 — Existing OS bridge */}
            <section className="space-y-3">
              <SectionBadge label="Any server" color="bg-violet-500/10 text-violet-600 dark:text-violet-400" />
              <h3 className="text-sm font-semibold text-foreground">Option 4 — Existing OS bridge</h3>
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
                <Step n={2}>Click <strong>New Network</strong>.</Step>
                <Step n={3}>Set <strong>Type</strong> to <Code>Existing OS bridge</Code>.</Step>
                <Step n={4}>
                  Set <strong>IP Mode</strong>:
                  <ul className="mt-2 space-y-1 text-sm text-muted-foreground list-disc list-inside">
                    <li><Code>DHCP</Code> — your upstream network assigns IPs to VMs.</li>
                    <li><Code>Static</Code> — VirtPilot assigns IPs from a pool you define. Enter the CIDR and gateway of the IP range you want VirtPilot to manage.</li>
                  </ul>
                </Step>
                <Step n={5}>
                  Enter the <strong>Bridge name</strong> exactly as it appears on the host (e.g. <Code>br0</Code>).
                  VirtPilot will verify the bridge exists before saving.
                </Step>
                <Step n={6}>Click <strong>Create</strong>.</Step>
              </Steps>
            </section>

            {/* IP Mode explainer */}
            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-foreground">IP Mode: DHCP vs Static</h3>
              <p className="text-sm text-muted-foreground">
                This setting controls how VMs get their IP addresses when connected to a bridge network.
              </p>
              <div className="space-y-3 text-sm">
                <div className="rounded-lg border border-border p-3">
                  <p className="font-medium text-foreground">DHCP</p>
                  <p className="mt-1 text-muted-foreground">
                    Your upstream router or DHCP server assigns an IP to each VM when it boots. You don't
                    manage IPs in VirtPilot — the upstream handles it. Best when VMs are on a LAN with an
                    existing DHCP server, or when your hosting provider handles DHCP for your network.
                  </p>
                </div>
                <div className="rounded-lg border border-border p-3">
                  <p className="font-medium text-foreground">Static</p>
                  <p className="mt-1 text-muted-foreground">
                    You define a CIDR block (e.g. <Code>203.0.113.0/29</Code>) and a gateway. VirtPilot
                    tracks which IP is assigned to which VM and injects the network configuration via
                    cloud-init when the VM is created. Best for public IP blocks where there is no DHCP
                    server — for example, additional IPs from your hosting provider that you've routed to
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
