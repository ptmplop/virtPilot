import { Router } from 'express';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { validateVmUuid, validateFilename } from '../lib/validate.js';
import { isIpAllowed } from '../middleware/auth.js';
import { getUserSettings } from '../services/userSettingsService.js';
import * as vmService from '../services/vmService.js';
import * as vmMetaService from '../services/vmMetaService.js';
import * as storageDirService from '../services/storageDirService.js';
import { appendLog } from '../services/logService.js';

export const downloadsRouter = Router();

interface DiskDownloadTicket {
  scope: 'disk-download';
  vmUuid: string;
  filename: string;
}

// Streams a VM disk file to the caller. Authentication is via a short-lived
// signed ticket (issued by POST /api/vms/:uuid/disk-files/:filename/download-ticket)
// — not the regular Bearer token, so it can ride safely in the URL of an
// anchor-triggered download without forcing the SPA to buffer multi-GB files
// into a Blob.
downloadsRouter.get('/disk', async (req, res) => {
  const token = typeof req.query.t === 'string' ? req.query.t : '';
  if (!token) {
    res.status(400).json({ error: 'Missing ticket' });
    return;
  }
  let payload: DiskDownloadTicket;
  try {
    payload = jwt.verify(token, config.jwtSecret) as DiskDownloadTicket;
  } catch {
    res.status(401).json({ error: 'Invalid or expired ticket' });
    return;
  }
  if (payload.scope !== 'disk-download') {
    res.status(403).json({ error: 'Ticket scope mismatch' });
    return;
  }

  const { ipWhitelist } = await getUserSettings();
  if (!isIpAllowed(req.ip, ipWhitelist)) {
    res.status(403).json({ error: 'IP not allowed' });
    return;
  }

  let vmUuid: string, filename: string;
  try {
    vmUuid = validateVmUuid(payload.vmUuid);
    filename = validateFilename(payload.filename);
  } catch {
    res.status(400).json({ error: 'Invalid ticket payload' });
    return;
  }
  if (!/\.qcow2$/i.test(filename)) {
    res.status(400).json({ error: 'Only qcow2 downloads are supported' });
    return;
  }

  // Look the disk up via vm_disk_locations — it may live on any registered
  // storage dir, not necessarily the system-root vmsDir.
  const diskLocations = await storageDirService.listDiskLocationsForVm(vmUuid);
  const match = diskLocations.find((d) => d.diskFilename === filename);
  if (!match) {
    res.status(404).json({ error: 'Disk file not found' });
    return;
  }
  const dir = await storageDirService.getDir(match.storageDirId);
  if (!dir) {
    res.status(404).json({ error: 'Disk storage dir missing' });
    return;
  }
  const filePath = path.join(storageDirService.getVmDisksSubdir(dir), vmUuid, filename);
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    res.status(404).json({ error: 'Disk file not found' });
    return;
  }
  if (!stat.isFile()) {
    res.status(404).json({ error: 'Disk file not found' });
    return;
  }

  // Re-check VM state at stream time — the ticket was minted when the VM was
  // stopped, but a sysadmin could have started it in the intervening seconds.
  // Streaming a live qcow2 yields a torn copy, so block it here too.
  let displayName = vmUuid;
  try {
    const vmInfo = await vmService.getVmInfo(vmUuid);
    displayName = vmInfo.name;
    if (vmInfo.status !== 'stopped') {
      res.status(409).json({ error: 'VM must be stopped before downloading its disk' });
      return;
    }
  } catch {
    // VM is undefined (orphaned disk) — allowed
    try {
      const meta = await vmMetaService.getVmMeta(vmUuid);
      if (meta?.name) displayName = meta.name;
    } catch { /* fall through */ }
  }

  const downloadName = `${displayName}-${filename}`.replace(/[^A-Za-z0-9._-]/g, '_');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
  res.setHeader('Cache-Control', 'no-store');

  void appendLog({
    type: 'vm.disk.download',
    subject: displayName,
    subjectUuid: vmUuid,
    status: 'success',
    output: `Downloading ${filename} (${stat.size} bytes)`,
  });

  const stream = fs.createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) {
      res.status(500).end();
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
});
