import { Router, type Response } from 'express';
import { VERSION } from '../config.js';
import * as deviceService from '../services/deviceService.js';
import { DeviceError } from '../services/deviceService.js';
import { getHostFacts } from '../services/hostScan.js';
import * as logService from '../services/logService.js';
import { formatTrace, type TraceEntry } from '../services/traceService.js';
import { buildPassthroughReport } from '../lib/passthroughReport.js';

export const devicesRouter = Router();

const DEVICE_ID_RE = /^(?:pci_[0-9a-f]{4}_[0-9a-f]{2}_[0-9a-f]{2}_[0-7]|usb_\d{1,3}-\d{1,3}(?:\.\d{1,3}){0,6})$/;

export function sendDeviceError(res: Response, err: unknown) {
  if (err instanceof DeviceError) return res.status(err.status).json({ error: err.message });
  return res.status(500).json({ error: String(err) });
}

// GET /api/devices: what this host can pass through, what it can't and why,
// and whether passthrough works here at all. ?refresh=1 skips the 3 s cache.
devicesRouter.get('/', async (req, res) => {
  try {
    res.json(await deviceService.getDeviceInventory(req.query.refresh === '1'));
  } catch (err) {
    sendDeviceError(res, err);
  }
});

// GET /api/devices/report: the same facts as plain text for a bug report, with
// the host's addresses and the VMs' names left out.
devicesRouter.get('/report', async (_req, res) => {
  try {
    const [inventory, facts] = await Promise.all([deviceService.getDeviceInventory(true), getHostFacts()]);
    res.type('text/plain').send(buildPassthroughReport(inventory, facts, VERSION));
  } catch (err) {
    sendDeviceError(res, err);
  }
});

// POST /api/devices/:id/keep { keep: boolean }: bind the device to vfio-pci
// now and at every boot (or give it back to the host).
devicesRouter.post('/:id/keep', async (req, res) => {
  const { id } = req.params;
  const keep = (req.body as { keep?: unknown })?.keep;
  if (!DEVICE_ID_RE.test(id) || typeof keep !== 'boolean') return res.status(400).json({ error: 'Invalid request' });
  const start = Date.now();
  const trace: TraceEntry[] = [];
  try {
    await deviceService.keepForVms(id, keep, trace);
    void logService.appendLog({ type: keep ? 'host.device.keep' : 'host.device.release', subject: id, status: 'success', output: formatTrace(trace), durationMs: Date.now() - start });
    res.json({ ok: true });
  } catch (err) {
    void logService.appendLog({ type: keep ? 'host.device.keep' : 'host.device.release', subject: id, status: 'error', output: err instanceof Error ? err.message : String(err), durationMs: Date.now() - start });
    sendDeviceError(res, err);
  }
});

// POST /api/devices/:id/virtual-functions { count: number }: switch a card's
// SR-IOV virtual functions on (now and at every boot), or off with 0.
devicesRouter.post('/:id/virtual-functions', async (req, res) => {
  const { id } = req.params;
  const count = (req.body as { count?: unknown })?.count;
  if (!DEVICE_ID_RE.test(id) || typeof count !== 'number' || !Number.isInteger(count)) return res.status(400).json({ error: 'Invalid request' });
  const start = Date.now();
  const trace: TraceEntry[] = [];
  try {
    await deviceService.setVirtualFunctions(id, count, trace);
    void logService.appendLog({ type: 'host.device.vfs', subject: id, status: 'success', output: formatTrace(trace), durationMs: Date.now() - start });
    res.json({ ok: true });
  } catch (err) {
    void logService.appendLog({ type: 'host.device.vfs', subject: id, status: 'error', output: err instanceof Error ? err.message : String(err), durationMs: Date.now() - start });
    sendDeviceError(res, err);
  }
});
