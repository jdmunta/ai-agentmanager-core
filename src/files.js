// Files: this computer's folders from a signed-in device, to send it a file (a photo from the
// phone, a document) and to fetch one from it (a log, a build, a screenshot). It reaches what a
// terminal on this computer reaches (Open Terminal), and is allowed where that is.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_LISTED = 2000;

const fail = (status, message) => Object.assign(new Error(message), { status });

export class Files {
  /** `home` is where it starts; what is sent goes to `inbox` (the Downloads folder). */
  constructor({ home = os.homedir(), inbox = null } = {}) {
    this.home = home;
    this.inbox = inbox ?? path.join(home, 'Downloads');
  }

  /** A path as typed or sent: `~` is the home folder, nothing is the home folder, anything else must be absolute. */
  resolve(p) {
    const text = String(p ?? '').trim();
    if (!text || text === '~') return this.home;
    if (text.startsWith('~/')) return path.join(this.home, text.slice(2));
    if (!path.isAbsolute(text)) throw fail(400, 'Give the whole path, or one that starts with ~/');
    return path.resolve(text);
  }

  /** A folder's files and folders, folders first. Hidden ones (a leading dot) only when asked for. */
  async list(dir, { hidden = false } = {}) {
    const at = this.resolve(dir);
    let names;
    try {
      names = await fs.promises.readdir(at, { withFileTypes: true });
    } catch (err) {
      throw fail(err.code === 'ENOENT' ? 404 : err.code === 'ENOTDIR' ? 400 : 403, err.code === 'ENOENT' ? `No folder ${at}` : err.code === 'ENOTDIR' ? `${at} is a file` : `${at} cannot be read (${err.code})`);
    }
    const shown = names.filter((d) => hidden || !d.name.startsWith('.'));
    const entries = (
      await Promise.all(
        shown.slice(0, MAX_LISTED).map(async (d) => {
          // Through a link too: what it points at is what gets opened.
          const st = await fs.promises.stat(path.join(at, d.name)).catch(() => null);
          if (!st || (!st.isDirectory() && !st.isFile())) return null;
          return { name: d.name, dir: st.isDirectory(), size: st.isDirectory() ? null : st.size, at: st.mtime.toISOString() };
        }),
      )
    ).filter(Boolean);
    entries.sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    const parent = path.dirname(at);
    return { dir: at, parent: parent === at ? null : parent, home: this.home, inbox: this.inbox, entries, more: Math.max(0, shown.length - MAX_LISTED) };
  }

  /** A file to send to the device: its path, name and size. */
  async file(p) {
    const at = this.resolve(p);
    const st = await fs.promises.stat(at).catch(() => null);
    if (!st) throw fail(404, `No file ${at}`);
    if (!st.isFile()) throw fail(400, `${at} is not a file`);
    return { path: at, name: path.basename(at), size: st.size };
  }

  /** Keep what a device sent: in `dir` (the inbox when none), under its own name, numbered if that is taken. */
  async save(name, data, dir = null) {
    const base = String(name ?? '').split(/[\\/]/).pop().replace(/[:\0]/g, '_').replace(/^\.+/, '') || 'file';
    const into = dir ? this.resolve(dir) : this.inbox;
    await fs.promises.mkdir(into, { recursive: true }).catch(() => {});
    const { name: stem, ext } = path.parse(base);
    for (let n = 1; n < 1000; n++) {
      const file = path.join(into, n === 1 ? base : `${stem} (${n})${ext}`);
      try {
        // wx: never over a file that is there.
        await fs.promises.writeFile(file, data, { flag: 'wx' });
        return { path: file, name: path.basename(file), dir: into, size: data.length };
      } catch (err) {
        if (err.code !== 'EEXIST') throw fail(err.code === 'ENOENT' ? 404 : 403, `${into} cannot be written to (${err.code})`);
      }
    }
    throw fail(409, `Too many files named ${base} in ${into}`);
  }
}
