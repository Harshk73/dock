// Reads what Dock needs to know about a GitHub repository, straight from the browser.
//
// File contents come from raw.githubusercontent.com (no rate limit, no token). The
// GitHub API is only used for nice-to-have metadata (description, stars, file tree)
// and is allowed to fail: unauthenticated callers get 60 requests an hour.

const PROBE_FILES = [
  "README.md", "readme.md", "README.rst", "README",
  "package.json", "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt",
  "Cargo.toml", "go.mod", "Makefile", "configure", "CMakeLists.txt", "meson.build", "install.sh", "Dockerfile", "docker-compose.yml",
  "SKILL.md", ".claude-plugin/plugin.json", ".claude-plugin/marketplace.json",
  "main.py", "app.py", "manage.py",
];

/** Accepts the forms people actually paste; returns null if it isn't a GitHub repo. */
export function parseRepoUrl(input) {
  let text = String(input || "").trim();
  if (!text) return null;
  const ssh = text.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (ssh) return { owner: ssh[1], repo: ssh[2], ref: null };
  text = text.replace(/^git\+/, "").replace(/^(https?:)?\/\//i, "").replace(/^www\./i, "");
  let m = text.match(/^github\.com\/([^/\s?#]+)\/([^/\s?#]+)(?:\/(?:tree|blob)\/([^/\s?#]+))?/i);
  if (!m) {
    m = text.match(/^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)$/);
    if (!m) return null;
  }
  const repo = m[2].replace(/\.git$/i, "");
  if (!repo || repo === "." || repo === "..") return null;
  return { owner: m[1], repo, ref: m[3] || null };
}

async function fetchText(url, init) {
  try {
    const res = await fetch(url, init);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function fetchJson(url, init) {
  const text = await fetchText(url, init);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function mentionsRepo(value, owner, repo) {
  return JSON.stringify(value || "").toLowerCase().includes(`github.com/${owner}/${repo}`.toLowerCase());
}

/**
 * @param {{owner: string, repo: string, ref: string|null}} target
 * @param {{token?: string}} [options]
 */
export async function fetchRepoFacts(target, options = {}) {
  const { owner, repo } = target;
  const ref = target.ref || "HEAD";
  const raw = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/`;
  const apiHeaders = { accept: "application/vnd.github+json" };
  if (options.token) apiHeaders.authorization = `Bearer ${options.token}`;
  const api = `https://api.github.com/repos/${owner}/${repo}`;

  const [contents, meta, tree] = await Promise.all([
    Promise.all(PROBE_FILES.map(name => fetchText(raw + name))),
    fetchJson(api, { headers: apiHeaders }),
    fetchJson(`${api}/git/trees/${ref}?recursive=1`, { headers: apiHeaders }),
  ]);
  const files = {};
  PROBE_FILES.forEach((name, i) => { if (contents[i] !== null) files[name] = contents[i]; });
  if (!Object.keys(files).length && !meta) {
    const err = new Error("Couldn't read that repository. Check the link, or it may be private.");
    err.code = "not-found";
    throw err;
  }

  const facts = {
    owner, repo, ref: target.ref || null,
    url: `https://github.com/${owner}/${repo}`,
    files,
    meta: meta && meta.full_name ? {
      description: meta.description || "",
      stars: meta.stargazers_count || 0,
      language: meta.language || "",
      topics: meta.topics || [],
      license: meta.license ? meta.license.spdx_id : "",
      sizeKb: meta.size || 0,
      archived: !!meta.archived,
    } : null,
    tree: tree && Array.isArray(tree.tree) ? tree.tree.map(t => t.path) : null,
    npm: null,
    pypi: null,
  };

  // Is the project published on a package registry under its own name? Installing the
  // published build is much faster than building from source inside the emulator.
  const lookups = [];
  if (files["package.json"]) {
    try {
      const pkg = JSON.parse(files["package.json"]);
      if (pkg.name && !pkg.private) {
        lookups.push(fetchJson(`https://registry.npmjs.org/${pkg.name.replace("/", "%2F")}/latest`).then(info => {
          if (info && info.name) {
            facts.npm = { name: info.name, version: info.version, bin: info.bin || null, matchesRepo: mentionsRepo(info.repository, owner, repo) };
          }
        }));
      }
    } catch { /* invalid package.json: the planner reports it */ }
  }
  const pyName = pythonProjectName(files) || repo;
  if (files["pyproject.toml"] || files["setup.py"] || files["setup.cfg"]) {
    lookups.push(fetchJson(`https://pypi.org/pypi/${encodeURIComponent(pyName)}/json`).then(info => {
      if (info && info.info) {
        facts.pypi = {
          name: info.info.name,
          version: info.info.version,
          requires: info.info.requires_dist || [],
          matchesRepo: mentionsRepo([info.info.project_urls, info.info.home_page], owner, repo),
        };
      }
    }));
  }
  await Promise.all(lookups);
  return facts;
}

/** The distribution name declared in pyproject.toml / setup.cfg / setup.py, if any. */
export function pythonProjectName(files) {
  const py = files["pyproject.toml"];
  if (py) {
    const section = py.match(/^\[(?:project|tool\.poetry)\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m);
    const name = section && section[1].match(/^\s*name\s*=\s*["']([^"']+)["']/m);
    if (name) return name[1];
  }
  const cfg = files["setup.cfg"];
  if (cfg) {
    const name = cfg.match(/^\s*name\s*=\s*([^\s#]+)/m);
    if (name) return name[1];
  }
  const setup = files["setup.py"];
  if (setup) {
    const name = setup.match(/\bname\s*=\s*["']([^"']+)["']/);
    if (name) return name[1];
  }
  return null;
}
