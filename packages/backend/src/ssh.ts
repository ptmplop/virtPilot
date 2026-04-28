import { WebSocketServer, WebSocket } from 'ws';
import { Client as SshClient } from 'ssh2';
import fs from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as vmMetaService from './services/vmMetaService.js';
import { ensureHostSshKeypair } from './services/cloudInitService.js';
import { config } from './config.js';

const execAsync = promisify(exec);

async function resolveVmIp(vmName: string): Promise<string | null> {
  try {
    const meta = await vmMetaService.getVmMeta(vmName);
    if (meta?.networks) {
      const primary = meta.networks.find((n) => n.isPrimary);
      if (primary?.ip) return primary.ip;
    }
  } catch { /* ignore */ }

  try {
    const { stdout } = await execAsync(`virsh -c ${config.libvirtUri} domifaddr "${vmName}" --source arp`);
    const match = stdout.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/\d+/);
    if (match) return match[1];
  } catch { /* VM not running or no ARP entry yet */ }

  return null;
}

export async function findHostPrivateKey(): Promise<Buffer | null> {
  const keyPath = await ensureHostSshKeypair();
  if (keyPath) {
    try { return await fs.readFile(keyPath); } catch { /* fall through */ }
  }
  return null;
}

export function createSshWss(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const vmName = url.searchParams.get('vm');

    if (!vmName) {
      ws.close(1008, 'Missing vm parameter');
      return;
    }

    const send = (msg: string) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    };

    send(`\r\n\x1b[2mResolving IP for ${vmName}…\x1b[0m\r\n`);

    const ip = await resolveVmIp(vmName);
    if (!ip) {
      send(`\r\n\x1b[31mCould not determine an IP address for "${vmName}".\x1b[0m\r\n`);
      send(`\x1b[2mEnsure the VM is running and has been assigned an IP.\x1b[0m\r\n`);
      ws.close(1011, 'No IP');
      return;
    }

    const meta = await vmMetaService.getVmMeta(vmName).catch(() => null);
    const username = meta?.username ?? 'root';

    const privateKey = await findHostPrivateKey();

    if (!privateKey && !meta?.password) {
      send(`\r\n\x1b[31mNo SSH credentials available — no private key found and no password in metadata.\x1b[0m\r\n`);
      ws.close(1011, 'No SSH credentials');
      return;
    }

    send(`\x1b[2mConnecting SSH to ${username}@${ip}…\x1b[0m\r\n`);

    const ssh = new SshClient();

    ssh.on('ready', () => {
      ssh.shell({ term: 'xterm-256color', cols: 220, rows: 50 }, (err, stream) => {
        if (err) {
          send(`\r\n\x1b[31mSSH shell error: ${err.message}\x1b[0m\r\n`);
          ssh.end();
          ws.close(1011, 'SSH shell error');
          return;
        }

        stream.on('data', (data: Buffer) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(data.toString());
        });

        stream.stderr.on('data', (data: Buffer) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(data.toString());
        });

        stream.on('close', () => {
          if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'SSH session closed');
          ssh.end();
        });

        ws.on('message', (data) => {
          const str = data.toString();
          try {
            const msg = JSON.parse(str) as { type?: string; cols?: number; rows?: number };
            if (msg.type === 'resize' && msg.cols && msg.rows) {
              stream.setWindow(msg.rows, msg.cols, 0, 0);
              return;
            }
          } catch { /* not JSON — treat as terminal input */ }
          stream.write(str);
        });

        ws.on('close', () => {
          stream.close();
          ssh.end();
        });

        ws.on('error', () => {
          stream.close();
          ssh.end();
        });
      });
    });

    ssh.on('error', (err) => {
      send(`\r\n\x1b[31mSSH error: ${err.message}\x1b[0m\r\n`);
      if (ws.readyState === WebSocket.OPEN) ws.close(1011, 'SSH error');
    });

    ssh.connect({
      host: ip,
      port: 22,
      username,
      ...(privateKey ? { privateKey } : {}),
      ...(meta?.password ? { password: meta.password } : {}),
      // Try publickey first, fall back to password if key auth is rejected
      authHandler: privateKey && meta?.password
        ? ['publickey', 'password']
        : privateKey ? ['publickey'] : ['password'],
      readyTimeout: 15_000,
    });
  });

  return wss;
}
