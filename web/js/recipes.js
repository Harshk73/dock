// Recipes turn a command-line tool into a tap-driven screen.
//
// A recipe says what the tool takes (a link or a file from the phone), which websites it
// works with, and a list of actions. Each action is a shell command built from a few
// form fields; Dock runs it in /root/Files and shows whatever files it produced.
//
// Tools without a hand-written recipe still get a screen: parseHelp() reads the tool's
// own --help text and turns every option into a switch or a text field.
//
// Pure data and functions: no DOM, no VM access.

const q = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
export const shellQuote = q;

/** "1:23" / "83" / "00:01:23.5" -> seconds, or null. */
export function parseTime(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(t)) return null;
  return t.split(":").reduce((sum, part) => sum * 60 + Number(part), 0);
}

export function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return "";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = n => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** Output file name next to the input: "clip.mp4" + "trim" + "mp4" -> "clip-trim.mp4". */
export function outputName(inputPath, suffix, ext) {
  const name = inputPath.split("/").pop();
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const oldExt = dot > 0 ? name.slice(dot + 1) : "";
  return `${stem}-${suffix}.${ext || oldExt || "out"}`;
}

// ------------------------------------------------------------------ yt-dlp

const YT_COMMON = `yt-dlp --no-playlist --newline --no-colors --restrict-filenames -P /root/Files -o "%(title).80B [%(id)s].%(ext)s"`;

function youtubeId(url) {
  const m = String(url).match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}

const ytDlp = {
  id: "yt-dlp",
  match: app => (app.bins || []).includes("yt-dlp"),
  title: "Media downloader",
  input: "link",
  sites: [
    { name: "YouTube", url: "https://www.youtube.com", searchable: true },
    { name: "Vimeo", url: "https://vimeo.com" },
    { name: "SoundCloud", url: "https://soundcloud.com" },
    { name: "Wikimedia Commons", url: "https://commons.wikimedia.org" },
  ],
  sitesNote: "and about a thousand other sites",
  placeholder: "Search YouTube or paste a link",
  notice: "Only download media you have the right to save.",
  isLink: text => /^https?:\/\/\S+$/i.test(text.trim()),
  search: {
    label: "YouTube",
    command: query => `yt-dlp --flat-playlist -J ${q(`ytsearch8:${query}`)} 2>/dev/null`,
    parse(text) {
      const data = JSON.parse(text.slice(text.indexOf("{")));
      return (data.entries || []).filter(e => e && e.id).map(e => ({
        url: e.url || `https://www.youtube.com/watch?v=${e.id}`,
        title: e.title || e.id,
        by: e.channel || e.uploader || "",
        duration: e.duration || null,
        views: e.view_count || null,
        thumbnail: `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`,
      }));
    },
  },
  inspect: {
    command: url => `yt-dlp --no-playlist --no-warnings -O ${q("%(.{id,title,uploader,channel,duration,thumbnail,webpage_url,extractor_key,view_count,height})j")} ${q(url)}`,
    parse(text, url) {
      const line = text.split("\n").find(l => l.trim().startsWith("{"));
      if (!line) throw new Error((text.match(/ERROR: (.*)/) || [])[1] || "Couldn't read that link.");
      const d = JSON.parse(line);
      const id = youtubeId(d.webpage_url || url);
      return {
        url: d.webpage_url || url,
        title: d.title || url,
        by: d.channel || d.uploader || "",
        duration: d.duration || null,
        views: d.view_count || null,
        thumbnail: d.thumbnail || (id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null),
        site: d.extractor_key || "",
        // YouTube's own embeddable player; other sites show the thumbnail.
        embed: id ? `https://www.youtube-nocookie.com/embed/${id}?playsinline=1` : null,
      };
    },
  },
  extras: {
    ffmpeg: { label: "FFmpeg", why: "joins separate video and sound tracks", check: "command -v ffmpeg", install: "apk add --no-cache ffmpeg" },
  },
  actions: [
    {
      id: "video", label: "Save video", detail: "MP4 that plays on iPhone",
      fields: [{ name: "quality", label: "Quality", type: "choice", default: "720", options: [["360", "360p · fastest"], ["720", "720p"], ["1080", "1080p"]] }],
      needs: f => (f.quality === "360" ? [] : ["ffmpeg"]),
      command: ({ url, f }) => f.quality === "360"
        ? `${YT_COMMON} -f "b[height<=360][ext=mp4]/b[ext=mp4]/b" ${q(url)}`
        : `${YT_COMMON} -S "vcodec:h264,res:${Number(f.quality)},acodec:m4a" -f "bv*[height<=${Number(f.quality)}]+ba/b[height<=${Number(f.quality)}]/b" --merge-output-format mp4 ${q(url)}`,
    },
    {
      id: "audio", label: "Save audio only", detail: "Music, podcasts, talks",
      fields: [{ name: "format", label: "Format", type: "choice", default: "m4a", options: [["m4a", "M4A · fastest"], ["mp3", "MP3"]] }],
      needs: f => (f.format === "mp3" ? ["ffmpeg"] : []),
      command: ({ url, f }) => f.format === "mp3"
        ? `${YT_COMMON} -f "ba/b" -x --audio-format mp3 ${q(url)}`
        : `${YT_COMMON} -f "ba[ext=m4a]/ba/b" ${q(url)}`,
    },
    {
      id: "subs", label: "Save subtitles", detail: "Captions as a text file",
      fields: [{ name: "lang", label: "Language code", type: "text", default: "en" }],
      command: ({ url, f }) => `${YT_COMMON} --skip-download --write-subs --write-auto-subs --sub-langs ${q(`${String(f.lang || "en").replace(/[^A-Za-z-]/g, "")}.*`)} --sub-format vtt ${q(url)}`,
    },
    {
      id: "thumb", label: "Save thumbnail", detail: "The cover image",
      command: ({ url }) => `${YT_COMMON} --skip-download --write-thumbnail ${q(url)}`,
    },
  ],
};

// ------------------------------------------------------------------ ffmpeg

const FF = "ffmpeg -hide_banner -nostdin -y";
const seconds = (value, fallback) => {
  const t = parseTime(value);
  return t === null ? fallback : t;
};

const ffmpeg = {
  id: "ffmpeg",
  match: app => (app.bins || []).includes("ffmpeg"),
  title: "Video and audio editor",
  input: "file",
  accept: "video/*,audio/*",
  placeholder: "Choose a video or audio file",
  inspect: {
    command: file => `ffprobe -v error -show_entries format=duration,size:stream=codec_type,codec_name,width,height -of json ${q(file)}`,
    parse(text) {
      const d = JSON.parse(text);
      const video = (d.streams || []).find(s => s.codec_type === "video");
      const audio = (d.streams || []).find(s => s.codec_type === "audio");
      return {
        duration: d.format && d.format.duration ? Number(d.format.duration) : null,
        summary: [video && `${video.width}×${video.height} ${video.codec_name}`, audio && `${audio.codec_name} sound`].filter(Boolean).join(" · "),
        hasVideo: !!video, hasAudio: !!audio,
      };
    },
  },
  actions: [
    {
      id: "trim", label: "Trim", detail: "Keep one part · instant",
      fields: [{ name: "start", label: "Start", type: "text", default: "0:00", placeholder: "0:00" }, { name: "end", label: "End", type: "text", default: "", placeholder: "end of file" }],
      command: ({ file, f }) => {
        const end = parseTime(f.end);
        return `${FF} -ss ${seconds(f.start, 0)} ${end === null ? "" : `-to ${end} `}-i ${q(file)} -c copy -avoid_negative_ts make_zero ${q(outputName(file, "trim"))}`;
      },
    },
    {
      id: "audio", label: "Extract the sound", detail: "Video to audio file",
      fields: [{ name: "format", label: "Format", type: "choice", default: "m4a", options: [["m4a", "M4A · instant"], ["mp3", "MP3"]] }],
      command: ({ file, f }) => f.format === "mp3"
        ? `${FF} -i ${q(file)} -vn -c:a libmp3lame -q:a 4 ${q(outputName(file, "audio", "mp3"))}`
        : `${FF} -i ${q(file)} -vn -c:a copy ${q(outputName(file, "audio", "m4a"))} || ${FF} -i ${q(file)} -vn -c:a aac -b:a 128k ${q(outputName(file, "audio", "m4a"))}`,
    },
    {
      id: "mute", label: "Remove the sound", detail: "Silent video · instant",
      command: ({ file }) => `${FF} -i ${q(file)} -an -c:v copy ${q(outputName(file, "silent"))}`,
    },
    {
      id: "gif", label: "Make a GIF", detail: "A few seconds as an animated image",
      slow: "Takes about as long as ten times the clip's length.",
      fields: [{ name: "start", label: "Start", type: "text", default: "0:00" }, { name: "length", label: "Seconds", type: "text", default: "3" }],
      command: ({ file, f }) => `${FF} -ss ${seconds(f.start, 0)} -t ${Math.min(15, seconds(f.length, 3))} -i ${q(file)} -vf "fps=10,scale=320:-2:flags=fast_bilinear" ${q(outputName(file, "clip", "gif"))}`,
    },
    {
      id: "shrink", label: "Make it smaller", detail: "Lower resolution, smaller file",
      slow: "Re-encoding is very slow inside Dock: expect several minutes per minute of video, even at low resolution.",
      fields: [{ name: "height", label: "Resolution", type: "choice", default: "360", options: [["240", "240p"], ["360", "360p"], ["480", "480p"]] }],
      command: ({ file, f }) => `${FF} -i ${q(file)} -vf scale=-2:${Number(f.height)} -c:v libx264 -preset veryfast -crf 28 -c:a copy ${q(outputName(file, `${Number(f.height)}p`, "mp4"))}`,
    },
  ],
};

export const RECIPES = [ytDlp, ffmpeg];

/** The hand-written recipe for an installed app, if there is one. */
export function findRecipe(app) {
  return RECIPES.find(recipe => recipe.match(app)) || null;
}

/** Websites to suggest right after a tool is installed. */
export function suggestedSites(app) {
  const recipe = findRecipe(app);
  return recipe && recipe.sites ? recipe.sites : [];
}

// ------------------------------------------------------------------ any other tool: read its --help

/**
 * Parses conventional --help output.
 * @returns {{usage: string, options: Array<{flag: string, short: string|null, arg: string|null, description: string, group: string}>, commands: Array<{name: string, description: string}>}}
 */
export function parseHelp(text) {
  const lines = String(text || "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "").split("\n");
  const options = [];
  const commands = [];
  let usage = "";
  let group = "";
  let current = null;
  let inCommands = false;
  const optionLine = /^\s{0,8}(?:(-[A-Za-z0-9?]),?\s+)?(--[A-Za-z0-9][\w.-]*)(?:[ =]\[?([A-Z_<][\w<>.|:\[\]-]*|\{[^}]+\})\]?)?(?:,\s+--?[\w-]+(?:[ =]\S+)?)*(?:\s{2,}(.*))?$/;
  for (const raw of lines) {
    const line = raw.replace(/\t/g, "    ");
    if (!usage && /^\s*usage:/i.test(line)) usage = line.replace(/^\s*usage:\s*/i, "").trim();
    const heading = line.match(/^([A-Z][\w /&-]{2,40}):\s*$/) || line.match(/^\s{0,2}([A-Z][\w /&-]{2,40}) options?:?\s*$/i);
    if (heading && !line.trim().startsWith("-")) {
      group = heading[1].trim();
      inCommands = /^(commands|subcommands|available commands)$/i.test(group);
      current = null;
      continue;
    }
    const m = line.match(optionLine);
    if (m && !/^\s{9,}/.test(line)) {
      if (m[2] === "--help" || m[2] === "--version") { current = null; continue; }
      current = { flag: m[2], short: m[1] || null, arg: m[3] || null, description: (m[4] || "").trim(), group };
      options.push(current);
      continue;
    }
    if (inCommands) {
      const c = line.match(/^\s{2,6}([a-z][\w-]*)(?:\s{2,}(.*))?$/);
      if (c) { commands.push({ name: c[1], description: (c[2] || "").trim() }); continue; }
    }
    if (current && /^\s{6,}\S/.test(line)) {
      current.description = `${current.description} ${line.trim()}`.trim();
    } else if (!line.trim()) {
      current = null;
    }
  }
  const seen = new Set();
  return { usage, commands, options: options.filter(o => !seen.has(o.flag) && seen.add(o.flag)) };
}

/**
 * Builds the command line for a tool from the options the user switched on.
 * @param {string} bin
 * @param {Array<{flag: string, value?: string}>} chosen
 * @param {{file?: string, extra?: string}} rest
 */
export function buildCommand(bin, chosen, { file = "", extra = "" } = {}) {
  const parts = [q(bin)];
  for (const { flag, value } of chosen) {
    parts.push(flag);
    if (value !== undefined && value !== null && value !== "") parts.push(q(value));
  }
  if (extra.trim()) parts.push(extra.trim()); // typed by the user as shell text, on purpose
  if (file) parts.push(q(file));
  return parts.join(" ");
}
