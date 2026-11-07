// Pure view model: no host imports. Time is injected through nowMs.

/** @typedef {import("./github.js").PR} PR */

export function isBot(pr, config) {
  return pr.author.isBotType === true || (config.bots || []).includes(pr.author.login);
}

export function classify(pr, config) {
  for (const rule of config.handOff || []) {
    // Repo names are case-insensitive on GitHub; branch names aren't.
    if (String(rule.repo).toLowerCase() !== String(pr.repo).toLowerCase() || rule.base !== pr.base) continue;
    if (rule.head && !pr.head.startsWith(rule.head)) continue;
    return { kind: "handoff", rule };
  }
  return { kind: pr.isDraft ? "draft" : "waiting" };
}

const ageMs = (createdAt, nowMs) => Math.max(0, nowMs - Date.parse(createdAt));

export function ageLevel(createdAt, nowMs, age) {
  const hours = ageMs(createdAt, nowMs) / 3600e3;
  if (hours >= age.lateHours) return "late";
  if (hours >= age.warnHours) return "warn";
  return "ok";
}

export function formatAge(createdAt, nowMs) {
  const ms = ageMs(createdAt, nowMs);
  const mins = Math.floor(ms / 60e3);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function ticketKeys(pr, tickets) {
  if (!tickets || !tickets.pattern) return [];
  const seen = new Set();
  for (const text of [pr.title, pr.head]) {
    for (const m of String(text || "").matchAll(tickets.pattern)) seen.add(m[0]);
  }
  return [...seen];
}

export function ticketUrl(key, tickets) {
  if (!tickets || !tickets.url) return null;
  return tickets.url.replaceAll("{key}", key);
}

export function buildView(prs, config, nowMs) {
  const repos = new Map();
  const handOff = new Map();
  let count = 0;
  for (const pr of prs) {
    const { kind, rule } = classify(pr, config);
    const item = {
      pr,
      kind,
      bot: isBot(pr, config),
      age: formatAge(pr.createdAt, nowMs),
      ageLevel: kind === "handoff" ? "ok" : ageLevel(pr.createdAt, nowMs, config.age),
      tickets: ticketKeys(pr, config.tickets),
    };
    const into = kind === "handoff" ? handOff : repos;
    const key = kind === "handoff" ? rule.label : pr.repo;
    if (!into.has(key)) into.set(key, []);
    into.get(key).push(item);
    if (kind === "waiting") count++;
  }
  const created = (i) => Date.parse(i.pr.createdAt);
  const oldestFirst = (a, b) => created(a) - created(b);
  const groups = [...repos].map(([repo, items]) => {
    items.sort(oldestFirst);
    const w = items.find((i) => i.kind === "waiting");
    return { repo, items, key: w ? created(w) : Infinity };
  });
  groups.sort((a, b) => (a.key === b.key ? 0 : a.key < b.key ? -1 : 1));
  return {
    count,
    groups: groups.map(({ repo, items }) => ({ repo, items })),
    handOff: [...handOff].map(([label, items]) => ({ label, items: items.sort(oldestFirst) })),
  };
}
