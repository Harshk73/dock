// Moving files between the phone and the Linux VM, through the guest agent.

export const FILES_DIR = "/root/Files";

const q = value => `'${String(value).replace(/'/g, `'\\''`)}'`;

/** A file name that is safe to use in the VM and on the phone. */
export function safeName(name) {
  const cleaned = String(name).normalize("NFKD").replace(/[^\w.\- ()\[\]]+/g, "_").replace(/^\.+/, "").trim();
  return cleaned.slice(-120) || "file";
}

/** Lists a directory: [{name, path, size, mtime}], newest first. */
export async function listFiles(agent, dir = FILES_DIR) {
  const { text } = await agent.capture(
    `mkdir -p ${q(dir)} && cd ${q(dir)} && for f in *; do [ -f "$f" ] && printf '%s\\t%s\\t%s\\n' "$(stat -c %s "$f")" "$(stat -c %Y "$f")" "$f"; done; true`);
  return text.split("\n").filter(Boolean).map(line => {
    const [size, mtime, ...rest] = line.split("\t");
    const name = rest.join("\t");
    return { name, path: `${dir}/${name}`, size: Number(size), mtime: Number(mtime) * 1000 };
  }).sort((a, b) => b.mtime - a.mtime);
}

/**
 * Copies bytes from the phone into the VM. Uses the page's network bridge when the VM
 * has one (fast), otherwise the agent's serial channel.
 * @param {{agent: object, bridge?: object}} vm
 * @param {(done: number, total: number) => void} [onProgress]
 * @returns {Promise<string>} the path written
 */
export async function writeFile(vm, path, bytes, onProgress) {
  const { agent, bridge } = vm;
  const dir = path.slice(0, path.lastIndexOf("/")) || "/";
  const part = path + ".part";
  if (bridge) {
    const url = bridge.offer(bytes, onProgress);
    const { code } = await agent.capture(`mkdir -p ${q(dir)} && curl -fsS ${q(url)} -o ${q(part)} && mv -f ${q(part)} ${q(path)}`);
    if (code === 0) return path;
  }
  const session = agent.open({ script: `mkdir -p ${q(dir)} && cat > ${q(part)} && mv -f ${q(part)} ${q(path)}`, pty: false, stdin: true });
  await session.writeAll(bytes, onProgress);
  session.end();
  if (await session.exited !== 0) throw new Error("The file could not be copied into Linux.");
  return path;
}

/** Uploads a File/Blob picked on the phone into dir, avoiding name clashes. */
export async function uploadFile(vm, file, dir = FILES_DIR, onProgress) {
  const existing = new Set((await listFiles(vm.agent, dir)).map(f => f.name));
  let name = safeName(file.name || "upload");
  if (existing.has(name)) {
    const dot = name.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    let n = 2;
    while (existing.has(`${stem} (${n})${ext}`)) n++;
    name = `${stem} (${n})${ext}`;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  return writeFile(vm, `${dir}/${name}`, bytes, onProgress);
}

/**
 * Reads a file out of the VM.
 * @param {{agent: object, bridge?: object}} vm
 * @returns {Promise<Uint8Array>}
 */
export async function readFile(vm, path, onProgress, total = 0) {
  const { agent, bridge } = vm;
  if (bridge) {
    const sink = bridge.expect(onProgress);
    const [{ code }, bytes] = await Promise.all([
      agent.capture(`curl -fsS -H Expect: -T ${q(path)} ${q(sink.url)}`).then(r => { if (r.code !== 0) sink.cancel(); return r; }),
      sink.done.catch(() => null),
    ]);
    if (code === 0 && bytes) return bytes;
  }
  const parts = [];
  let done = 0;
  const code = await agent.run(`cat ${q(path)}`, bytes => {
    parts.push(bytes);
    done += bytes.length;
    if (onProgress) onProgress(done, total);
  }, { pty: false });
  if (code !== 0) throw new Error("The file could not be read.");
  const out = new Uint8Array(done);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

export async function deleteFile(agent, path) {
  await agent.capture(`rm -f ${q(path)}`);
}

const TYPES = {
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", ogg: "audio/ogg", opus: "audio/ogg", flac: "audio/flac",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", json: "application/json", csv: "text/csv",
  srt: "application/x-subrip", vtt: "text/vtt", html: "text/html", zip: "application/zip",
};

export function mimeType(name) {
  return TYPES[String(name).split(".").pop().toLowerCase()] || "application/octet-stream";
}

export function fileKind(name) {
  const type = mimeType(name);
  return type.startsWith("video/") ? "video" : type.startsWith("audio/") ? "audio" : type.startsWith("image/") ? "image" : "file";
}

/** True when the phone's share sheet can take this file (Save to Files, Save Video, AirDrop...). */
export function canShareFiles(name) {
  try {
    return !!navigator.canShare && navigator.canShare({ files: [new File([new Uint8Array(1)], name, { type: mimeType(name) })] });
  } catch {
    return false;
  }
}

/**
 * Hands a file to the phone: the share sheet where available, otherwise a normal
 * browser download. Call it directly from a tap: iOS refuses to open the share sheet
 * otherwise.
 * @returns {Promise<"shared"|"cancelled"|"downloaded">}
 */
export async function saveToPhone(name, bytes) {
  const file = new File([bytes], name, { type: mimeType(name) });
  if (canShareFiles(name)) {
    try {
      await navigator.share({ files: [file] });
      return "shared";
    } catch (err) {
      if (err && err.name === "AbortError") return "cancelled";
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return "downloaded";
}
