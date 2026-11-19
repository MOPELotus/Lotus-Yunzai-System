export interface VersionCardEntry {
  readonly title: string;
  readonly notes?: readonly string[];
}

export interface VersionCardRelease {
  readonly version: string;
  readonly entries: readonly VersionCardEntry[];
}

export interface RuntimeVersion {
  readonly version?: string;
  readonly revision?: string;
  readonly modified?: boolean;
  readonly modules: readonly { readonly name: string; readonly revision: string }[];
  readonly changelog?: readonly VersionCardRelease[];
}

const versionLabel = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)*$/u;

function line(value: string): string | undefined {
  const clean = value.replace(/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, " ").trim();
  if (clean) return [...clean].slice(0, 240).join("");
}

/** Project only explicit first-party release notes supplied with the runtime version. */
export function publicVersionChanges(runtime?: RuntimeVersion): readonly VersionCardRelease[] {
  const releases: VersionCardRelease[] = [];
  const versions = new Set<string>();
  for (const release of runtime?.changelog ?? []) {
    const version = release.version;
    if (version.length > 80 || !versionLabel.test(version) || versions.has(version)) continue;
    const entries: VersionCardEntry[] = [];
    for (const entry of release.entries.slice(0, 20)) {
      const title = line(entry.title);
      if (!title) continue;
      const notes = (entry.notes ?? []).slice(0, 6).map(line).filter((text): text is string => text !== undefined);
      entries.push({ title, ...(notes.length > 0 && { notes }) });
    }
    if (!entries.length) continue;
    versions.add(version);
    releases.push({ version, entries });
    if (releases.length === 5) break;
  }
  return releases;
}

export function versionCardSections(runtime?: RuntimeVersion): readonly VersionCardRelease[] {
  const version = runtime?.version || "开发构建";
  const revision = runtime?.revision?.slice(0, 12) || "提交号不可用";
  const modified = runtime?.modified ? "（有本地修改）" : "";
  const modules = runtime?.modules.map(({ name, revision }) => `${name}　${revision.slice(0, 12)}`) ?? [];
  const releases = publicVersionChanges(runtime);
  const current = releases.find(release => release.version === version);
  return [
    { version, entries: [
      { title: `宿主提交　${revision}${modified}` },
      { title: "内置模块", notes: modules.length ? modules : ["暂无内置模块版本记录"] },
      ...(current?.entries ?? []),
    ] },
    ...releases.filter(release => release.version !== version).slice(0, 4),
  ];
}
