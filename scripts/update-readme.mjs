import { readFileSync, writeFileSync } from "node:fs";

const USER = process.env.GH_USER ?? process.env.GITHUB_REPOSITORY_OWNER;
const TOKEN = process.env.GITHUB_TOKEN;
const README = "README.md";
const START = "<!--REPOS:START-->";
const END = "<!--REPOS:END-->";

if (!USER) throw new Error("Defina GH_USER ou rode dentro do GitHub Actions.");

// Ordem importa: o primeiro grupo que casar (topic ou nome) vence.
const GROUPS = [
  { title: "Amazon Connect & Omnichannel", topics: ["amazon-connect"], match: /^amazon-connect/i },
  { title: "AWS", topics: ["aws"], match: /^aws-/i },
  { title: "Azure & IA", topics: ["azure"], match: /azure/i },
];
const FALLBACK = "Outros";
const HIDE_TOPIC = "hide"; // adicione o topic "hide" a um repo para escondê-lo
const MAX_TAGS = 5;
const FIRST = ["aws-serverless-rag-reference"]; // sempre no topo do seu grupo, nesta ordem

const headers = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  ...(TOKEN && { Authorization: `Bearer ${TOKEN}` }),
};

async function fetchRepos() {
  const all = [];
  for (let page = 1; ; page++) {
    const res = await fetch(
      `https://api.github.com/users/${USER}/repos?type=owner&sort=pushed&per_page=100&page=${page}`,
      { headers },
    );
    if (!res.ok) throw new Error(`REST ${res.status}: ${await res.text()}`);
    const data = await res.json();
    all.push(...data);
    if (data.length < 100) break;
  }
  return all;
}

async function fetchPinned() {
  if (!TOKEN) return [];
  const query = `query($login:String!){user(login:$login){pinnedItems(first:6,types:REPOSITORY){nodes{... on Repository{name}}}}}`;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables: { login: USER } }),
  });
  if (!res.ok) {
    console.warn(`GraphQL ${res.status}: pinados ignorados.`);
    return [];
  }
  const json = await res.json();
  return json.data?.user?.pinnedItems?.nodes?.map((n) => n.name) ?? [];
}

const esc = (s = "") => s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
const clip = (s, n = 150) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function tags(repo) {
  const list = [repo.language, ...repo.topics.filter((t) => t !== HIDE_TOPIC)]
    .filter(Boolean)
    .filter((t, i, a) => a.findIndex((x) => x.toLowerCase() === t.toLowerCase()) === i)
    .slice(0, MAX_TAGS);
  return list.map((t) => `\`${t}\``).join(" ");
}

function table(repos) {
  const rows = repos.map(
    (r) => `| **[${r.name}](${r.html_url})** | ${esc(clip(r.description ?? ""))} | ${tags(r)} |`,
  );
  return ["| Repositório | Descrição | Tags |", "|---|---|---|", ...rows].join("\n");
}

function groupOf(repo) {
  const g = GROUPS.find(
    (g) => g.topics?.some((t) => repo.topics.includes(t)) || g.match?.test(repo.name),
  );
  return g?.title ?? FALLBACK;
}

const [raw, pinnedNames] = await Promise.all([fetchRepos(), fetchPinned()]);

const repos = raw.filter(
  (r) =>
    !r.private &&
    !r.fork &&
    !r.archived &&
    r.name.toLowerCase() !== USER.toLowerCase() &&
    !(r.topics ?? []).includes(HIDE_TOPIC),
);
repos.forEach((r) => (r.topics ??= []));

const pinnedRank = new Map(pinnedNames.map((n, i) => [n, i]));
const NONE = 1e6;
const rank = (r) => {
  const f = FIRST.indexOf(r.name);
  if (f !== -1) return f;
  const p = pinnedRank.get(r.name);
  return p !== undefined ? FIRST.length + p : NONE;
};

// Ordem: FIRST, depois pinados do GitHub, depois o mais recente.
repos.sort((a, b) => rank(a) - rank(b) || new Date(b.pushed_at) - new Date(a.pushed_at));

const buckets = new Map();
for (const r of repos) {
  const key = groupOf(r);
  if (!buckets.has(key)) buckets.set(key, []);
  buckets.get(key).push(r);
}

const order = [...GROUPS.map((g) => g.title), FALLBACK];
const sections = [];
for (const title of order) {
  const list = buckets.get(title);
  if (list?.length) sections.push(`### ${title}\n\n${table(list)}`);
}

const body = sections.join("\n\n");
const src = readFileSync(README, "utf8");
const re = new RegExp(`${START}[\\s\\S]*?${END}`);
if (!re.test(src)) throw new Error("Marcadores REPOS:START/END não encontrados no README.");

const next = src.replace(re, () => `${START}\n\n${body}\n\n${END}`);
if (next !== src) {
  writeFileSync(README, next);
  console.log(`README atualizado: ${repos.length} repositórios listados.`);
} else {
  console.log("Sem mudanças.");
}
