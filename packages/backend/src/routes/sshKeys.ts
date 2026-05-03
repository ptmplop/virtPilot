import { Router } from 'express';
import { listSshKeys, addSshKey, deleteSshKey } from '../services/sshKeyService.js';

export const sshKeysRouter = Router();

// Recognised OpenSSH public-key types. The wire format is "<type> <base64-blob> [comment]"
// where the base64 blob's first length-prefixed string equals <type>; we don't fully
// re-validate the blob here — we just gate on the well-known type prefix and the
// base64 charset, which is enough to reject "this is not a key".
const SSH_KEY_TYPE = /^(ssh-rsa|ssh-dss|ssh-ed25519|ssh-ed448|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)$/;
const SSH_KEY_BLOB = /^[A-Za-z0-9+/]+={0,2}$/;

function isValidSshPublicKey(line: string): boolean {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2) return false;
  const [type, blob] = parts;
  if (!SSH_KEY_TYPE.test(type)) return false;
  if (blob.length < 32) return false;
  if (!SSH_KEY_BLOB.test(blob)) return false;
  return true;
}

sshKeysRouter.get('/', async (_req, res) => {
  try {
    const keys = await listSshKeys();
    res.json({ keys });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

sshKeysRouter.post('/', async (req, res) => {
  try {
    const { name, publicKey } = req.body as { name?: string; publicKey?: string };
    if (!name?.trim() || !publicKey?.trim()) {
      res.status(400).json({ error: 'name and publicKey are required' });
      return;
    }
    if (!isValidSshPublicKey(publicKey)) {
      res.status(400).json({ error: 'publicKey is not a valid OpenSSH public key (expected "<type> <base64-blob> [comment]")' });
      return;
    }
    const key = await addSshKey(name.trim(), publicKey.trim());
    res.status(201).json({ key });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

sshKeysRouter.delete('/:id', async (req, res) => {
  try {
    const ok = await deleteSshKey(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'Key not found' });
      return;
    }
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});
